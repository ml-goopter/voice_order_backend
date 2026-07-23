import type { CartOperation } from '../../contracts/cart-operation.schema.js';
import type { CartView } from '../../contracts/cart-view.js';
import type { MenuItem } from '../../menu/menu-types.js';
import { displayName } from '../../shared/display-name.js';

/**
 * Enforce required modifier groups on a `propose_cart` batch (docs/pos-product-modifier-order-schema.md
 * §Required modifiers). A required group is a per-product option group with
 * `display_type <> 'multi'` — the customer must pick EXACTLY ONE. Odoo does not enforce this
 * server-side (the addon that would is uninstalled), and the POS silently pre-selects the first
 * option; for a voice UX we instead reject and let the agent ASK which the customer wants.
 *
 * The check runs over the modifier set that RESULTS from the whole batch, not op-by-op, so a
 * "swap" (`remove_modifier` old + `add_modifier` new on the same line) nets to exactly one and
 * passes, while a lone `add_modifier` that duplicates a required group, or a `remove_modifier`
 * that empties one, is caught.
 *
 * Pure: returns one agent-readable message per violation ([] when compliant). It never throws and
 * never blocks on a menu miss — an `add_item` whose item did not resolve is skipped (degrade),
 * matching the module's read-at-request-time stance.
 */

/** The minimal option shape shared by menu candidates and cart-view modifiers. */
interface ModOption {
  modifier_key: string;
  name: string;
  group_key?: string;
  group_name?: string;
  required?: boolean;
}

/**
 * Check that every required group in `options` holds EXACTLY ONE selected key.
 * `onlyGroups`, when given, narrows the check to those group keys — used for edits, where a batch
 * must only be judged on the groups it actually touched.
 */
function checkExactlyOne(
  selectedKeys: string[],
  options: ModOption[],
  itemLabel: string,
  onlyGroups?: Set<string>,
): string[] {
  const groupOf = new Map<string, string>(); // modifier_key → group_key
  const groupName = new Map<string, string>(); // group_key → group display name
  const optionNames = new Map<string, string[]>(); // group_key → option names (for the message)
  const requiredGroups = new Set<string>();
  for (const o of options) {
    if (o.group_key === undefined) continue;
    groupOf.set(o.modifier_key, o.group_key);
    if (o.group_name !== undefined) groupName.set(o.group_key, o.group_name);
    optionNames.set(o.group_key, [...(optionNames.get(o.group_key) ?? []), o.name]);
    if (o.required) requiredGroups.add(o.group_key);
  }
  if (requiredGroups.size === 0) return [];

  const counts = new Map<string, number>();
  for (const key of selectedKeys) {
    const g = groupOf.get(key);
    if (g === undefined) continue; // a key not on this item — cart validates keys, not us
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }

  const out: string[] = [];
  for (const g of requiredGroups) {
    if (onlyGroups !== undefined && !onlyGroups.has(g)) continue;
    const n = counts.get(g) ?? 0;
    if (n === 1) continue;
    const gname = groupName.get(g) ?? 'a required option';
    const opts = (optionNames.get(g) ?? []).join(', ');
    if (n === 0) {
      // "End the turn by asking", never "propose again": the customer cannot answer inside the
      // agent loop, so an in-loop retry can only be a guess or a run to the step limit (which the
      // customer hears as silence).
      out.push(
        `"${itemLabel}" requires exactly one choice for "${gname}" (options: ${opts}), but none was selected. Do not guess: end this turn with a spoken reply asking the customer which they want.`,
      );
    } else {
      out.push(
        `"${itemLabel}" allows only one choice for "${gname}" (options: ${opts}), but ${n} were selected. Keep exactly one.`,
      );
    }
  }
  return out;
}

/** Resulting per-line modifier state after applying a batch's edit ops. */
interface LineState {
  options: ModOption[]; // the line's available_modifiers (group metadata source)
  label: string;
  keys: string[]; // selected modifier_keys after the batch
  /** The groups an add/remove_modifier in this batch actually changed. ONLY these are judged: a
   *  batch that adds a side must not be rejected over a required group it never touched (a line can
   *  arrive non-compliant — created before this check shipped, or via a degraded add_item). */
  touchedGroups: Set<string>;
  removed: boolean; // remove_item dropped this line
}

export function findRequiredModifierViolations(
  ops: CartOperation[],
  cartView: CartView | null,
  itemsByKey: Map<string, MenuItem>,
): string[] {
  const violations: string[] = [];

  // 1) add_item: the resulting modifier set IS the op's inline modifiers.
  for (const op of ops) {
    if (op.action !== 'add_item') continue;
    const item = itemsByKey.get(op.menu_item_key);
    if (item === undefined) continue; // stale/unknown item — degrade, don't block on a menu miss
    // An unavailable item is the cart's rejection to make (`unavailable_item`). Asking which
    // noodles they want for a dish we cannot sell wastes a turn to arrive at the same refusal.
    if (!item.available) continue;
    const label = displayName(item.names, item.menu_item_key);
    violations.push(...checkExactlyOne(op.modifiers.map((m) => m.modifier_key), item.modifiers, label));
  }

  // 2) edit ops on existing lines: simulate the whole batch per line, then validate the result.
  //    Guard is truthy, not `!== null`: the channel defaults to null in production, but a caller
  //    passing `undefined` must degrade rather than throw on `.items`.
  if (cartView) {
    const lines = new Map<string, LineState>();
    const stateOf = (lineId: string): LineState | undefined => {
      const existing = lines.get(lineId);
      if (existing !== undefined) return existing;
      const line = cartView.items.find((l) => l.line_id === lineId);
      if (line === undefined) return undefined; // unknown line — cart validates line_id, not us
      const st: LineState = {
        options: line.available_modifiers,
        label: line.name,
        keys: line.modifiers.map((m) => m.modifier_key),
        touchedGroups: new Set(),
        removed: false,
      };
      lines.set(lineId, st);
      return st;
    };
    /** The group a modifier_key belongs to on this line, when the menu gives it one. */
    const groupOf = (st: LineState, key: string): string | undefined =>
      st.options.find((o) => o.modifier_key === key)?.group_key;

    for (const op of ops) {
      if (op.action === 'add_modifier') {
        const st = stateOf(op.line_id);
        if (st === undefined) continue;
        const g = groupOf(st, op.modifier_key);
        if (g !== undefined) st.touchedGroups.add(g);
        if (!st.keys.includes(op.modifier_key)) st.keys.push(op.modifier_key);
      } else if (op.action === 'remove_modifier') {
        const st = stateOf(op.line_id);
        if (st === undefined) continue;
        const g = groupOf(st, op.modifier_key);
        if (g !== undefined) st.touchedGroups.add(g);
        st.keys = st.keys.filter((k) => k !== op.modifier_key);
      } else if (op.action === 'remove_item') {
        const st = stateOf(op.line_id);
        if (st !== undefined) st.removed = true;
      }
    }

    // Judge a line ONLY on the groups this batch changed. A line can arrive non-compliant (created
    // before this check shipped, or via the degraded add_item path, or because a ptav was archived
    // out of available_modifiers), and adding a side must not turn into an interrogation about a
    // required group the customer never mentioned.
    for (const st of lines.values()) {
      if (st.removed || st.touchedGroups.size === 0) continue;
      violations.push(...checkExactlyOne(st.keys, st.options, st.label, st.touchedGroups));
    }
  }

  // Two identical add_item ops would otherwise emit the same sentence twice.
  return [...new Set(violations)];
}
