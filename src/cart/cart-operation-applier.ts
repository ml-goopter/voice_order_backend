import type { PosConfigId } from '../shared/types.js';
import type { Result } from '../shared/result.js';
import { err, ok } from '../shared/result.js';
import { CartRejectedError } from '../shared/errors.js';
import { newLineId } from '../shared/ids.js';
import { nowIso } from '../shared/time.js';
import type { MenuLookup } from '../menu/menu-service.js';
import type { CandidateModifier } from '../menu/menu-types.js';
import { displayName } from '../shared/display-name.js';
import type { Cart, CartLine, CartModifier } from './cart-types.js';
import type { CartOperation } from '../contracts/cart-operation.schema.js';

const reject = (reason: string, message: string): Result<Cart, CartRejectedError> =>
  err(new CartRejectedError(reason, message));

/** Snapshot a resolved menu modifier onto a cart line, capturing all-language names when present. */
const toCartModifier = (mod: CandidateModifier): CartModifier => ({
  ptav_id: mod.ptav_id,
  name: mod.name,
  ...(mod.names !== undefined ? { names: mod.names } : {}),
});

/** Recompute totals from menu prices — base plus per-unit modifier surcharges. TODO: tax (§9). */
async function priced(cart: Cart, items: CartLine[], menu: MenuLookup, pos: PosConfigId): Promise<Cart> {
  // One batched read for every distinct line item, rather than a GET per line.
  const tmpls = [...new Set(items.map((l) => l.product_tmpl_id))];
  const menuItems = await menu.getItems(pos, tmpls);
  const priceOf = new Map(menuItems.map((i) => [i.product_tmpl_id, i.base_price_cents]));
  // Surcharges come from the menu, not the line's snapshot — the same rule base prices
  // follow. ptav_id is a PK, so one flat map cannot collide across items.
  const extraOf = new Map(
    menuItems.flatMap((i) => i.modifiers.map((m) => [m.ptav_id, m.price_extra_cents] as const)),
  );
  const subtotal = items.reduce((sum, line) => {
    const unit =
      (priceOf.get(line.product_tmpl_id) ?? 0) +
      line.modifiers.reduce((acc, m) => acc + (extraOf.get(m.ptav_id) ?? 0), 0);
    return sum + unit * line.quantity;
  }, 0);
  return { ...cart, items, subtotal_cents: subtotal, tax_cents: 0, total_cents: subtotal, last_updated: nowIso() };
}

/**
 * Applies ONE validated operation to a cart, returning a new cart (design §9).
 * The Cart Module is the only place line_ids are assigned and menu keys resolve to
 * Odoo ids. Version bump/persistence is the controller's job.
 */
export async function applyOperation(
  cart: Cart,
  op: CartOperation,
  menu: MenuLookup,
  pos: PosConfigId,
): Promise<Result<Cart, CartRejectedError>> {
  switch (op.action) {
    case 'add_item': {
      const item = await menu.resolveItemKey(pos, op.menu_item_key);
      if (!item || !item.available) return reject('unavailable_item', 'That item is not available.');
      const modifiers: CartModifier[] = [];
      for (const ref of op.modifiers) {
        const mod = item.modifiers.find((m) => m.modifier_key === ref.modifier_key);
        if (!mod) return reject('invalid_modifier', `${displayName(item.names, item.menu_item_key)} does not support that option.`);
        modifiers.push(toCartModifier(mod));
      }
      const line: CartLine = {
        line_id: newLineId(),
        product_tmpl_id: item.product_tmpl_id,
        name: displayName(item.names, item.menu_item_key),
        // Snapshot every language's name so the client can display in the customer's
        // locale; `name` above stays the single-string default/fallback.
        names: item.names,
        quantity: op.quantity,
        modifiers,
      };
      return ok(await priced(cart, [...cart.items, line], menu, pos));
    }

    case 'remove_item': {
      if (!cart.items.some((l) => l.line_id === op.line_id)) return reject('line_gone', 'That item is no longer in your cart.');
      return ok(await priced(cart, cart.items.filter((l) => l.line_id !== op.line_id), menu, pos));
    }

    case 'update_quantity': {
      if (!cart.items.some((l) => l.line_id === op.line_id)) return reject('line_gone', 'That item is no longer in your cart.');
      if (op.quantity <= 0) return reject('invalid_quantity', 'Quantity must be at least 1.');
      const items = cart.items.map((l) => (l.line_id === op.line_id ? { ...l, quantity: op.quantity } : l));
      return ok(await priced(cart, items, menu, pos));
    }

    case 'add_modifier':
    case 'remove_modifier': {
      const line = cart.items.find((l) => l.line_id === op.line_id);
      if (!line) return reject('line_gone', 'That item is no longer in your cart.');
      const menuItem = await menu.findByTmplId(pos, line.product_tmpl_id);
      const mod = menuItem?.modifiers.find((m) => m.modifier_key === op.modifier_key);
      if (!mod) return reject('invalid_modifier', 'That option is not valid for this item.');
      const modifiers =
        op.action === 'add_modifier'
          ? line.modifiers.some((m) => m.ptav_id === mod.ptav_id)
            ? line.modifiers
            : [...line.modifiers, toCartModifier(mod)]
          : line.modifiers.filter((m) => m.ptav_id !== mod.ptav_id);
      const items = cart.items.map((l) => (l.line_id === op.line_id ? { ...l, modifiers } : l));
      return ok(await priced(cart, items, menu, pos));
    }
  }
}
