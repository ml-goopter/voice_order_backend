import { z } from 'zod';
import type { AgentMessage, ToolCall } from '../../llm/llm-provider.js';
import type { MenuService } from '../../menu/menu-service.js';
import type { OrderStateType } from '../graph/state.js';
import type { OrderGraphOutput } from '../schemas/order-graph-output.schema.js';
import { parseOrderGraphOutput } from '../schemas/order-graph-output.schema.js';
import { formatZodError } from '../schemas/zod-error.js';
import { TOOL_NAMES } from './tool-specs.js';
import { logger } from '../../config/logger.js';

const searchArgs = z.object({ query: z.string().min(1) });

/** What one tool call produced: a `content` string appended to the scratchpad (fed back to the
 *  model on a loop), plus `output` when `propose_cart` validated (the terminal action). */
interface ToolExecResult {
  content: string;
  output?: OrderGraphOutput;
}

/** Execute one tool call against the (in-progress) turn state. */
async function executeToolCall(menu: MenuService, s: OrderStateType, call: ToolCall): Promise<ToolExecResult> {
  switch (call.name) {
    case TOOL_NAMES.search: {
      const parsed = searchArgs.safeParse(call.arguments);
      if (!parsed.success) return { content: `Invalid arguments: ${formatZodError(parsed.error)}` };
      const set = await menu.getCandidates(s.pos_config_id, parsed.data.query);
      return { content: JSON.stringify(set.items) };
    }
    case TOOL_NAMES.propose: {
      const argsObj = (call.arguments ?? {}) as Record<string, unknown>;
      const result = parseOrderGraphOutput({ operations: argsObj.operations });
      if (!result.ok) return { content: `Validation error: ${result.error.message}` };
      // `operations` defaults to [] when absent/unparsable, so a malformed call would otherwise
      // "succeed" as an empty proposal and silently drop the customer's request. Reject it as a
      // retriable tool error instead — a turn with nothing to change must end with a spoken reply.
      if (result.value.operations.length === 0) {
        return {
          content:
            'Validation error: propose_cart needs at least one operation. If there is nothing to change, do not call propose_cart — reply to the customer in words instead.',
        };
      }
      return { content: 'Proposal accepted.', output: result.value };
    }
    default:
      return { content: `Error: unknown tool "${call.name}".` };
  }
}

/**
 * The `tools` node (docs/agent-tools.md §3.1): run the tool calls the agent just requested, append
 * each result to the turn scratchpad (`agent_messages`), and carry the `output` a successful
 * `propose_cart` set. Returns a state patch. A `propose_cart` that fails validation sets no
 * `output` — it is a tool error the agent retries (bounded by `maxAgentSteps`); the loop router
 * sends control back to the agent because no terminal channel was written.
 */
export async function runTools(menu: MenuService, s: OrderStateType): Promise<Partial<OrderStateType>> {
  const last = s.agent_messages.at(-1);
  const calls = last?.role === 'assistant' && last.tool_calls ? last.tool_calls : [];

  let output = s.output;
  const toolMsgs: AgentMessage[] = [];

  for (const call of calls) {
    const res = await executeToolCall(menu, s, call);
    toolMsgs.push({ role: 'tool', tool_call_id: call.id, content: res.content });
    if (res.output !== undefined) output = res.output;
    logger.info('order.agent_tool', { tool: call.name, request_id: s.request_id });
  }

  return { agent_messages: [...s.agent_messages, ...toolMsgs], output };
}
