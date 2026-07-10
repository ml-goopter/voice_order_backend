import { describe, it, expect } from 'vitest';
import { buildPrompt, buildRepairPrompt } from './prompt-builder.js';
import { cartOperationSchema } from '../ordering/schemas/cart-operation.schema.js';
import type { OrderGraphInput } from '../ordering/schemas/order-graph-input.schema.js';
import type { CandidateItem } from '../menu/menu-types.js';

const CANDIDATE: CandidateItem = {
  menu_item_key: 'sweet_sour_chicken',
  product_tmpl_id: 42,
  name: 'Sweet and Sour Chicken',
  available_modifiers: [
    { modifier_key: 'add_broccoli', ptav_id: 1, name: 'Add broccoli' },
    { modifier_key: 'extra_sauce', ptav_id: 2, name: 'Extra sauce' },
    { modifier_key: 'no_onion', ptav_id: 3, name: 'No onion' },
  ],
};

function makeInput(overrides: Partial<OrderGraphInput> = {}): OrderGraphInput {
  return {
    request_id: 'voice_final_abc',
    session_id: 'voice_session_1',
    cart_id: 'cart_1',
    pos_config_id: 1,
    customer_text: 'one sweet and sour chicken with broccoli',
    current_cart: { cart_id: 'cart_1', pos_config_id: 1, version: 3, items: [] },
    candidate_items: [CANDIDATE],
    history: [],
    supported_languages: ['en_US'],
    ...overrides,
  };
}

describe('buildPrompt', () => {
  it('returns a non-empty system string and a JSON-parseable user payload', () => {
    const { system, user } = buildPrompt(makeInput());
    expect(system.length).toBeGreaterThan(0);
    expect(() => JSON.parse(user)).not.toThrow();
  });

  it('advertises exactly the operations the validation schema accepts', () => {
    const allowed = cartOperationSchema.options.map((o) => o.shape.action.value);
    const { system } = buildPrompt(makeInput());
    for (const action of allowed) {
      expect(system).toContain(action);
    }
  });

  it('preserves each candidate item\'s FULL available_modifiers list un-trimmed', () => {
    const { user } = buildPrompt(makeInput());
    const payload = JSON.parse(user);
    const mods = payload.candidate_items[0].available_modifiers;
    expect(mods).toHaveLength(CANDIDATE.available_modifiers.length);
    expect(mods.map((m: { modifier_key: string }) => m.modifier_key)).toEqual([
      'add_broccoli',
      'extra_sauce',
      'no_onion',
    ]);
  });

  it('maps the graph input fields onto the user payload', () => {
    const input = makeInput({
      language: 'en_US',
      history: [{ customer_text: 'a coke' }],
    });
    const payload = JSON.parse(buildPrompt(input).user);
    expect(payload.request_id).toBe('voice_final_abc');
    expect(payload.customer_text).toBe(input.customer_text);
    expect(payload.language).toBe('en_US');
    expect(payload.current_cart).toEqual(input.current_cart);
    expect(payload.candidate_items).toEqual(input.candidate_items);
    expect(payload.conversation_history).toEqual(input.history);
  });

  it('omits the clarification block when clarification_question is undefined', () => {
    const payload = JSON.parse(buildPrompt(makeInput()).user);
    expect('clarification' in payload).toBe(false);
  });

  it('includes the clarification block when clarification_question is defined', () => {
    const input = makeInput({ clarification_question: 'Which size?' });
    const payload = JSON.parse(buildPrompt(input).user);
    expect(payload.clarification).toEqual({ question: 'Which size?' });
  });
});

describe('buildRepairPrompt', () => {
  it('appends the repair instruction to the base system prompt', () => {
    const input = makeInput();
    const base = buildPrompt(input);
    const repair = buildRepairPrompt(input, '{bad', 'not valid JSON');
    expect(repair.system.startsWith(base.system)).toBe(true);
    expect(repair.system).toContain('failed schema validation');
    expect(repair.system).toContain('STRICT JSON');
  });

  it('appends the invalid output and validation error to the base user prompt', () => {
    const input = makeInput();
    const base = buildPrompt(input);
    const repair = buildRepairPrompt(input, '{bad output', 'operations: expected array');
    expect(repair.user.startsWith(base.user)).toBe(true);
    expect(repair.user).toContain('PREVIOUS_INVALID_OUTPUT:\n{bad output');
    expect(repair.user).toContain('VALIDATION_ERROR: operations: expected array');
  });

  it('retains the base prompt content (candidates and cart still present)', () => {
    const repair = buildRepairPrompt(makeInput(), 'x', 'y');
    expect(repair.user).toContain('sweet_sour_chicken');
    expect(repair.user).toContain('candidate_items');
  });
});
