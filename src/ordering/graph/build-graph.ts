import { StateGraph, MemorySaver, START, END } from '@langchain/langgraph';
import { OrderState } from './state.js';
import type { OrderStateType } from './state.js';
import { node } from './instrument.js';
import type { MenuService } from '../../menu/menu-service.js';
import type { LlmProvider, AgentMessage } from '../../llm/llm-provider.js';
import type { CartCache } from '../../redis/cart-cache.js';
import { LIMITS } from '../../config/constants.js';
import { INTENT_ROUTE } from './intents.js';
import { classifyIntent } from '../nodes/classify-intent.node.js';
import { normalizeTranscript } from '../nodes/normalize-transcript.node.js';
import { loadCart, buildCartView } from '../nodes/load-cart.node.js';
import { buildAgentMessages } from '../../llm/agent-prompt-builder.js';
import { TOOL_SPECS } from '../tools/tool-specs.js';
import { runTools } from '../tools/run-tools.js';
import { parseSpokenReply } from './parse-spoken-reply.js';

export interface GraphDeps {
  menu: MenuService;
  llm: LlmProvider; // the proposer/agent LLM (must be tool-capable)
  intentLlm: LlmProvider; // the intent classifier's own LLM (its own creds; design §6)
  carts: CartCache;
}

/** Build the turn's seed messages from graph state (cart is loaded before the agent runs). The
 *  `language` channel is deliberately NOT passed: it holds the unreliable STT-detected code, and
 *  the agent reads the language off `customer_text` instead (see agent-prompt-builder). */
function seedMessages(s: OrderStateType): AgentMessage[] {
  return buildAgentMessages({
    customer_text: s.customer_text,
    current_cart: s.cart_view!,
    history: s.history,
  });
}

/** Does the agent's most recent reply request tool calls? (Drives the agent → tools loop edge.) */
function lastAssistantHasToolCalls(s: OrderStateType): boolean {
  const last = s.agent_messages.at(-1);
  return last?.role === 'assistant' && (last.tool_calls?.length ?? 0) > 0;
}

/**
 * The Order Understanding graph (docs/agent-tools.md §3). `normalize → classify → load_cart →
 * agent ⇄ tools → finalize`. `classify` is a binary junk-gate: `service` routes into the agent
 * pipeline, `junk` short-circuits to END. The agent drives retrieval (`search_menu_semantic`) and
 * ends the turn either by committing operations (`propose_cart`) or by replying to the customer in
 * words (no tool call) — a single "reply" outcome that serves as both a clarifying question and a
 * recommendation. A reply is fire-and-forget: it ends the turn; the customer's answer arrives as
 * the NEXT transcript (normalize/classify force `order` so a terse follow-up isn't misrouted).
 * Compiled with a checkpointer so history follows the cart across turns.
 */
export function buildOrderGraph({ menu, llm, intentLlm, carts }: GraphDeps) {
  return new StateGraph(OrderState)
    // First hop: normalize the raw transcript and reset ALL turn-scoped channels (the checkpointer
    // persists everything, so anything not cleared would leak into the next turn): the terminal
    // outcomes (`output`/`reply`) and the agent scratchpad. Durable cart/session/history context
    // persists via the checkpointer.
    .addNode('normalize', node('normalize', (s) => ({
      customer_text: normalizeTranscript(s.customer_text),
      output: null,
      reply: null,
      reply_language: undefined,
      agent_messages: [],
      agent_steps: 0,
      failure_reason: undefined,
    })))
    // Then label the NORMALIZED utterance so the graph can route it. If the previous turn ended in
    // a spoken reply (its `agent_reply` is the last history entry), THIS utterance is likely the
    // answer to it, so force `service` and skip the classifier's LLM call — the agent resolves the
    // reply against the current utterance. Otherwise classify; the classifier degrades to `service`
    // on any failure so a real order is never dropped. `classify` is a junk-gate only: the choice
    // is binary, and the agent (not the router) works out what the customer wants.
    .addNode('classify', node('classify', async (s) => {
      if (s.history.at(-1)?.agent_reply !== undefined) return { intent: 'service' as const };
      const intent = await classifyIntent(intentLlm, s.customer_text);
      return { intent };
    }))
    .addNode('load_cart', node('load_cart', async (s) => {
      const cart = await loadCart(carts, s.cart_id, s.pos_config_id);
      const cart_view = await buildCartView(menu, cart);
      return { cart_view, base_version: cart.version };
    }))
    // The agent: one LLM tool-calling turn. Seeds the transcript (system + user context) on first
    // entry, then appends the model's reply. If the model returns no tool call, the turn ends with
    // its spoken `reply` (or `agent_no_terminal` if it said nothing). Bails with `agent_step_limit`
    // once the loop has taken `maxAgentSteps` turns without committing to a terminal.
    .addNode('agent', node('agent', async (s) => {
      const step = s.agent_steps + 1;
      if (step > LIMITS.maxAgentSteps) return { failure_reason: 'agent_step_limit' };
      const messages = s.agent_messages.length === 0 ? seedMessages(s) : s.agent_messages;
      const res = await llm.chat(messages, TOOL_SPECS);
      const assistant: AgentMessage = {
        role: 'assistant',
        ...(res.text !== undefined ? { content: res.text } : {}),
        ...(res.toolCalls.length > 0 ? { tool_calls: res.toolCalls } : {}),
      };
      const base = { agent_messages: [...messages, assistant], agent_steps: step };
      // No tool call → the agent ended the turn by speaking. The reply is strict JSON
      // {reply, language}; parse it and record the declared language on its own turn-scoped channel
      // (never on the `language` input channel — that would outlive the turn). Non-JSON text
      // degrades to being spoken as-is with no language; a blob with no usable reply is the same
      // degenerate terminal as empty text was.
      if (res.toolCalls.length === 0) {
        const { reply, language } = parseSpokenReply(res.text);
        if (reply === null) return { ...base, failure_reason: 'agent_no_terminal' };
        return { ...base, reply, ...(language !== undefined ? { reply_language: language } : {}) };
      }
      return base;
    }))
    // Run the tool calls the agent just requested; a successful `propose_cart` writes `output`.
    .addNode('tools', node('tools', (s) => runTools(menu, s)))
    // Record the completed turn. When the agent ended by SPEAKING, keep its reply as `agent_reply`
    // so the next turn (whose utterance may answer it) has the context and force-orders. A turn
    // that committed operations (or failed) records only its utterance.
    .addNode('finalize', node('finalize', (s) => ({
      history: [
        {
          customer_text: s.customer_text,
          ...(s.reply !== null ? { agent_reply: s.reply } : {}),
        },
      ],
    })))
    .addEdge(START, 'normalize')
    .addEdge('normalize', 'classify')
    // Junk-gate fan-out: the router returns the intent, INTENT_ROUTE maps it (service → load_cart,
    // junk → END).
    .addConditionalEdges('classify', (s) => s.intent, INTENT_ROUTE)
    .addEdge('load_cart', 'agent')
    // After the agent replies: run its tool calls, or end the turn (it spoke a reply, hit the step
    // limit, or said nothing).
    .addConditionalEdges(
      'agent',
      (s) => {
        if (s.failure_reason !== undefined || s.reply !== null) return 'finalize';
        return lastAssistantHasToolCalls(s) ? 'tools' : 'finalize';
      },
      { tools: 'tools', finalize: 'finalize' },
    )
    // After tools: a successful propose_cart set `output` → finalize; otherwise loop to the agent.
    .addConditionalEdges('tools', (s) => (s.output !== null ? 'finalize' : 'agent'), {
      agent: 'agent',
      finalize: 'finalize',
    })
    .addEdge('finalize', END)
    .compile({ checkpointer: new MemorySaver() });
}
