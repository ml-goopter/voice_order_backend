import type { PosConfigId } from '../shared/types.js';
import type { Result } from '../shared/result.js';
import { err, ok } from '../shared/result.js';
import { CartRejectedError } from '../shared/errors.js';
import { newLineId } from '../shared/ids.js';
import { nowIso } from '../shared/time.js';
import type { MenuService } from '../menu/menu-service.js';
import type { Cart, CartLine, CartModifier } from './cart-types.js';
import type { CartOperation } from '../ordering/schemas/cart-operation.schema.js';

const reject = (reason: string, message: string): Result<Cart> =>
  err(new CartRejectedError(reason, message));

/** Recompute totals from menu prices. TODO: modifier price deltas + tax (§9). */
function priced(cart: Cart, items: CartLine[], menu: MenuService, pos: PosConfigId): Cart {
  let subtotal = 0;
  for (const line of items) {
    const item = menu.findByTmplId(pos, line.product_tmpl_id);
    subtotal += (item?.base_price_cents ?? 0) * line.quantity;
  }
  return { ...cart, items, subtotal_cents: subtotal, tax_cents: 0, total_cents: subtotal, last_updated: nowIso() };
}

/**
 * Applies ONE validated operation to a cart, returning a new cart (design §9).
 * The Cart Module is the only place line_ids are assigned and menu keys resolve to
 * Odoo ids. Version bump/persistence is the controller's job.
 */
export function applyOperation(
  cart: Cart,
  op: CartOperation,
  menu: MenuService,
  pos: PosConfigId,
): Result<Cart> {
  switch (op.action) {
    case 'add_item': {
      const item = menu.resolveItemKey(pos, op.menu_item_key);
      if (!item || !item.available) return reject('unavailable_item', 'That item is not available.');
      const modifiers: CartModifier[] = [];
      for (const ref of op.modifiers) {
        const mod = item.modifiers.find((m) => m.modifier_key === ref.modifier_key);
        if (!mod) return reject('invalid_modifier', `${item.names['en_US'] ?? item.menu_item_key} does not support that option.`);
        modifiers.push({ ptav_id: mod.ptav_id });
      }
      const line: CartLine = {
        line_id: newLineId(),
        product_tmpl_id: item.product_tmpl_id,
        quantity: op.quantity,
        modifiers,
      };
      return ok(priced(cart, [...cart.items, line], menu, pos));
    }

    case 'remove_item': {
      if (!cart.items.some((l) => l.line_id === op.line_id)) return reject('line_gone', 'That item is no longer in your cart.');
      return ok(priced(cart, cart.items.filter((l) => l.line_id !== op.line_id), menu, pos));
    }

    case 'update_quantity': {
      if (!cart.items.some((l) => l.line_id === op.line_id)) return reject('line_gone', 'That item is no longer in your cart.');
      if (op.quantity <= 0) return reject('invalid_quantity', 'Quantity must be at least 1.');
      const items = cart.items.map((l) => (l.line_id === op.line_id ? { ...l, quantity: op.quantity } : l));
      return ok(priced(cart, items, menu, pos));
    }

    case 'add_modifier':
    case 'remove_modifier': {
      const line = cart.items.find((l) => l.line_id === op.line_id);
      if (!line) return reject('line_gone', 'That item is no longer in your cart.');
      const menuItem = menu.findByTmplId(pos, line.product_tmpl_id);
      const mod = menuItem?.modifiers.find((m) => m.modifier_key === op.modifier_key);
      if (!mod) return reject('invalid_modifier', 'That option is not valid for this item.');
      const modifiers =
        op.action === 'add_modifier'
          ? line.modifiers.some((m) => m.ptav_id === mod.ptav_id)
            ? line.modifiers
            : [...line.modifiers, { ptav_id: mod.ptav_id }]
          : line.modifiers.filter((m) => m.ptav_id !== mod.ptav_id);
      const items = cart.items.map((l) => (l.line_id === op.line_id ? { ...l, modifiers } : l));
      return ok(priced(cart, items, menu, pos));
    }
  }
}
