import { describe, it, expect } from 'vitest';
import {
  buildAgentSystemPrompt,
  buildAgentUserMessage,
  buildAgentMessages,
  type AgentContext,
} from './agent-prompt-builder.js';
import { cartOperationSchema } from '../contracts/cart-operation.schema.js';
import type { CartView, HistoryTurn } from '../contracts/cart-view.js';

const cart: CartView = { cart_id: 'c1', pos_config_id: 7, version: 3, items: [] };
const history: HistoryTurn[] = [{ customer_text: 'hi', agent_reply: 'hello' }];
const ctx: AgentContext = { customer_text: 'two burgers', current_cart: cart, history };

describe('buildAgentSystemPrompt', () => {
  it('advertises exactly the operations cartOperationSchema validates (advertised can never drift from validated)', () => {
    const actions = cartOperationSchema.options.map((o) => o.shape.action.value);
    const line = buildAgentSystemPrompt()
      .split('\n')
      .find((l) => l.startsWith('Allowed operations:'));
    expect(line).toBeDefined();
    const advertised = line!
      .replace('Allowed operations:', '')
      .replace(/\.$/, '')
      .split(',')
      .map((s) => s.trim());
    expect(new Set(advertised)).toEqual(new Set(actions));
  });

  it('scrubs JSON-Schema noise ($schema header, the unbounded-int maximum sentinel) from the embedded schema', () => {
    const prompt = buildAgentSystemPrompt();
    expect(prompt).not.toContain('$schema');
    expect(prompt).not.toContain(String(Number.MAX_SAFE_INTEGER)); // 9007199254740991
    expect(prompt).toContain('MUST match this JSON Schema'); // the schema block is still present
  });

  it('states the MENTIONED ITEMS rule: keys only, this turn\'s searches only, omit when nothing named', () => {
    const prompt = buildAgentSystemPrompt();
    expect(prompt).toContain('MENTIONED ITEMS');
    expect(prompt).toContain('Keys ONLY — never names, never prices.');
    expect(prompt).toContain("Only keys from THIS turn's search_menu results are usable");
    expect(prompt).toContain('Omit "mentioned_items" entirely when your reply names no items.');
  });

  it('shows the standalone spoken JSON example with language, reply, mentioned_items in that order', () => {
    const prompt = buildAgentSystemPrompt();
    const languageIdx = prompt.indexOf('"language":');
    const replyIdx = prompt.indexOf('"reply":');
    const mentionedIdx = prompt.indexOf('"mentioned_items":');
    expect(languageIdx).toBeGreaterThan(-1);
    expect(replyIdx).toBeGreaterThan(languageIdx);
    expect(mentionedIdx).toBeGreaterThan(replyIdx);
  });
});

describe('buildAgentUserMessage', () => {
  it('maps history → conversation_history and carries the utterance + cart verbatim', () => {
    const parsed = JSON.parse(buildAgentUserMessage(ctx)) as Record<string, unknown>;
    expect(parsed.customer_text).toBe('two burgers');
    expect(parsed.current_cart).toMatchObject({ cart_id: 'c1', version: 3 });
    expect(parsed.conversation_history).toEqual(history);
    expect(parsed).not.toHaveProperty('history'); // renamed on the wire
  });
});

describe('buildAgentMessages', () => {
  it('seeds [system, user] with matching roles and content', () => {
    const msgs = buildAgentMessages(ctx);
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user']);
    const [system, user] = msgs;
    expect(system?.role === 'system' ? system.content : undefined).toBe(buildAgentSystemPrompt());
    if (user?.role !== 'user') throw new Error('expected a user message');
    expect((JSON.parse(user.content) as { customer_text: string }).customer_text).toBe('two burgers');
  });
});
