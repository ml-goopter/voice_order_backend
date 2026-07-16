import { describe, it, expect } from 'vitest';
import type { Result } from '../shared/result.js';
import { ValidationError } from '../shared/errors.js';
import { parseCartOperation, type CartOperation } from './cart-operation.schema.js';

/** Unwrap an ok Result or fail loudly. */
function expectOk(r: Result<CartOperation>): CartOperation {
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error.message}`);
  return r.value;
}

describe('parseCartOperation', () => {
  describe('add_item', () => {
    it('parses a valid add_item and defaults modifiers to []', () => {
      const op = expectOk(parseCartOperation({ action: 'add_item', menu_item_key: 'burger', quantity: 2 }));
      expect(op).toEqual({ action: 'add_item', menu_item_key: 'burger', quantity: 2, modifiers: [] });
    });

    it('keeps supplied modifiers', () => {
      const op = expectOk(
        parseCartOperation({ action: 'add_item', menu_item_key: 'burger', quantity: 1, modifiers: [{ modifier_key: 'no_mayo' }] }),
      );
      expect(op.action === 'add_item' && op.modifiers).toEqual([{ modifier_key: 'no_mayo' }]);
    });

    // This is the ONLY guard on add_item quantity — the applier consumes op.quantity
    // directly (cart-operation-applier.ts:52) with no re-check, unlike update_quantity.
    it('rejects a quantity of 0', () => {
      expect(parseCartOperation({ action: 'add_item', menu_item_key: 'burger', quantity: 0 }).ok).toBe(false);
    });

    it('rejects a negative quantity', () => {
      expect(parseCartOperation({ action: 'add_item', menu_item_key: 'burger', quantity: -1 }).ok).toBe(false);
    });

    it('rejects a non-integer quantity', () => {
      expect(parseCartOperation({ action: 'add_item', menu_item_key: 'burger', quantity: 1.5 }).ok).toBe(false);
    });

    it('rejects an empty menu_item_key', () => {
      expect(parseCartOperation({ action: 'add_item', menu_item_key: '', quantity: 1 }).ok).toBe(false);
    });

    it('rejects a missing menu_item_key', () => {
      expect(parseCartOperation({ action: 'add_item', quantity: 1 }).ok).toBe(false);
    });
  });

  it('parses each of the five actions', () => {
    expect(parseCartOperation({ action: 'add_item', menu_item_key: 'x', quantity: 1 }).ok).toBe(true);
    expect(parseCartOperation({ action: 'remove_item', line_id: 'ln_1' }).ok).toBe(true);
    expect(parseCartOperation({ action: 'update_quantity', line_id: 'ln_1', quantity: 3 }).ok).toBe(true);
    expect(parseCartOperation({ action: 'add_modifier', line_id: 'ln_1', modifier_key: 'no_mayo' }).ok).toBe(true);
    expect(parseCartOperation({ action: 'remove_modifier', line_id: 'ln_1', modifier_key: 'no_mayo' }).ok).toBe(true);
  });

  it('rejects update_quantity with a non-positive quantity', () => {
    expect(parseCartOperation({ action: 'update_quantity', line_id: 'ln_1', quantity: 0 }).ok).toBe(false);
  });

  it('rejects an unknown action', () => {
    expect(parseCartOperation({ action: 'teleport', line_id: 'ln_1' }).ok).toBe(false);
  });

  it('rejects a missing required field (line_id)', () => {
    expect(parseCartOperation({ action: 'remove_item' }).ok).toBe(false);
  });

  it('rejects an empty modifier_key', () => {
    expect(parseCartOperation({ action: 'add_modifier', line_id: 'ln_1', modifier_key: '' }).ok).toBe(false);
  });

  it('rejects a non-object input', () => {
    expect(parseCartOperation(null).ok).toBe(false);
    expect(parseCartOperation('add_item').ok).toBe(false);
  });

  it('returns a ValidationError with a message on failure', () => {
    const r = parseCartOperation({ action: 'add_item', menu_item_key: 'burger', quantity: 0 });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBeInstanceOf(ValidationError);
    expect(r.error.message).toBeTruthy();
  });
});
