# Plan A — Self-describing cart + persisted conversation context

Implementation plan for making multi-turn cart edits **deterministic**. Three changes, all
feeding the LLM prompt with information it currently lacks:

1. **Self-describing cart** — enrich each `current_cart` line at load time with its item
   name, `menu_item_key`, currently-attached modifiers (resolved to keys+names), and the
   item's `available_modifiers`. So an edit like "add broccoli to the chicken" can resolve
   `line_id` + `modifier_key` from the cart alone, with no numeric join and no reliance on a
   candidate surviving.
2. **Persisted conversation context** — carry each turn's `customer_text` and any
   `clarification_answer` forward and re-send them to the model as a short rolling history,
   so references like "that", "the same", "make it two" resolve against what was actually
   said.
3. **Keep Plan B** — candidate accumulation stays exactly as shipped; it still supplies
   `available_modifiers` for **new** items (`add_item`) and recently-seen items. This plan
   layers on top of it, it does not replace it.

Read Plan B (`docs/plan-b-candidate-accumulation.md`) first — this plan assumes the
accumulating `candidates` channel is already in place.

---

## Background — the gaps this closes

Per turn the graph runs `normalize → load_cart → retrieve → parse` (`build-graph.ts`), and
the LLM call is stateless (only `[system, user]`, no message history —
`openai-compatible-provider.ts`). Two structural gaps remain after Plan B:

- **`current_cart` is numeric-only.** A `CartLine` (`src/cart/cart-types.ts`) carries only
  `line_id`, numeric `product_tmpl_id`, and `modifiers: [{ ptav_id }]` — no item name, no
  `menu_item_key`, no `modifier_key`, no `available_modifiers`. So the model cannot map "the
  chicken" → a `line_id`, cannot know a line's valid modifier vocabulary for `add_modifier`,
  and cannot name a currently-attached modifier for `remove_modifier`. Plan B only *maybe*
  helps here — a surviving candidate is **not linked to a `line_id`**, so the model must
  numerically join `candidate.product_tmpl_id ↔ line.product_tmpl_id`, which is fragile and
  breaks once the candidate is evicted.
- **No dialogue memory.** `customer_text` is overwritten every turn and `clarification_answer`
  is cleared by `normalize` at the start of each fresh turn (`build-graph.ts`). Nothing about
  prior utterances reaches the next turn's prompt, so cross-turn references have nothing to
  resolve against.

The cart is already the durable source of truth (persisted in Redis, reloaded fresh each
turn), so the fix for edits is to make the loaded view **complete**, not to make more graph
state survive. Dialogue references genuinely need state to survive — handled by (2).

---

## Scope

**In:**
- A prompt-facing enriched cart view type (name + keys + resolved/available modifiers).
- Enrich the cart in the `load_cart` node via a batch menu lookup.
- A rolling `history` state channel + a `finalize` node that appends the completed turn.
- Feed both into `OrderGraphInput` and render them in `buildPrompt`.
- Two cap constants.
- Update the prompt wording, tests, and knowledge base.

**Out:**
- The stored `Cart` / `CartLine` shape (`src/cart/cart-types.ts`) and the Redis contract —
  **do not touch**. Enrichment is a read-time, prompt-only projection.
- Candidate accumulation (Plan B) — unchanged.
- How `retrieve` matches (`menu.getCandidates`) — unchanged.
- The Cart Module's apply/validate path — unchanged; it still consumes `line_id` +
  `menu_item_key` from the proposal.

---

## Changes

### 1. Cap constants — `src/config/constants.ts`

Add to `LIMITS`:

```ts
/** Plan A — turns of prior (utterance + clarification answer) resent to the model as context. */
maxHistoryTurns: 6,
```

(`maxAccumulatedCandidates` from Plan B stays.)

### 2. Prompt-facing view + history types — `src/ordering/schemas/order-graph-input.schema.ts`

Add view types (kept out of `cart-types.ts` so the Redis contract is untouched). Note these
carry **keys and names, not numeric ids** — the numeric `product_tmpl_id`/`ptav_id` are
deliberately omitted so the model can't mistake one for a `line_id` (see the 2026-07-08
"inline modifiers" log entry — leaked numeric ids caused invented `line_id`s).

```ts
export interface CartModifierView {
  modifier_key: string;
  name: string;
}

export interface CartLineView {
  line_id: LineId;            // the stable string id edits must target
  menu_item_key: string;
  name: string;
  quantity: number;
  modifiers: CartModifierView[];            // currently attached (resolved from ptav_id)
  available_modifiers: CartModifierView[];  // options for this item, for add_modifier
}

export interface CartView {
  cart_id: CartId;
  pos_config_id: PosConfigId;
  version: number;
  items: CartLineView[];
}

export interface HistoryTurn {
  customer_text: string;
  clarification_answer?: string;
}
```

Then change `OrderGraphInput`:

```ts
current_cart: CartView;          // was: Cart
history: HistoryTurn[];          // new — prior turns, oldest → newest
```

### 3. Build the enriched view — `src/ordering/nodes/load-cart.node.ts`

Add a `buildCartView(menu, cart)` helper (keep `loadCart` as is). One batched menu round trip
(`menu.getItems`, which already exists on `MenuService`); resolve each line's item and map its
attached `ptav_id`s to `{ modifier_key, name }` via the item's own `modifiers` list. Degrade
gracefully if an item is missing from the menu (fall back to the numeric id as name, empty
modifier lists) so a stale cart line never throws.

```ts
export async function buildCartView(menu: MenuLookup, cart: Cart): Promise<CartView> {
  const tmplIds = [...new Set(cart.items.map((l) => l.product_tmpl_id))];
  const items = await menu.getItems(cart.pos_config_id, tmplIds);
  const byTmpl = new Map(items.map((i) => [i.product_tmpl_id, i]));
  return {
    cart_id: cart.cart_id,
    pos_config_id: cart.pos_config_id,
    version: cart.version,
    items: cart.items.map((line) => {
      const item = byTmpl.get(line.product_tmpl_id);
      const avail = item?.modifiers ?? [];
      return {
        line_id: line.line_id,
        menu_item_key: item?.menu_item_key ?? String(line.product_tmpl_id),
        name: item?.names?.en_US ?? String(line.product_tmpl_id),
        quantity: line.quantity,
        modifiers: line.modifiers
          .map((m) => avail.find((a) => a.ptav_id === m.ptav_id))
          .filter(Boolean)
          .map((a) => ({ modifier_key: a!.modifier_key, name: a!.name })),
        available_modifiers: avail.map((a) => ({ modifier_key: a.modifier_key, name: a.name })),
      };
    }),
  };
}
```

### 4. State + wiring — `src/ordering/graph/state.ts` and `build-graph.ts`

**state.ts** — replace the raw `cart` channel with `cart_view`, and add the accumulating
`history` channel (append, capped, keep newest):

```ts
cart_view: lww<CartView | null>(() => null),
history: appendHistory(),   // reducer: (prev, next) => [...prev, ...next].slice(-LIMITS.maxHistoryTurns)
```

`base_version` still comes from the freshly loaded cart inside the node, so no separate raw
`cart` channel is needed. (`mergeCandidates` from Plan B is unchanged.)

**build-graph.ts:**

- `load_cart` node returns `{ cart_view: await buildCartView(menu, cart), base_version: cart.version }`.
- `toInput` sends `current_cart: s.cart_view!` and `history: s.history`.
- Add a **`finalize`** node on the completion branch that records the turn:

  ```ts
  .addNode('finalize', (s) => ({
    history: [{
      customer_text: s.customer_text,
      ...(s.clarification_answer !== undefined ? { clarification_answer: s.clarification_answer } : {}),
    }],
  }))
  ```

  Rewire the decision edge so completion goes through `finalize` before `END`:

  ```
  parse → decide { clarification ? 'clarify' : 'finalize' }
  finalize → END
  clarify → parse
  ```

  `finalize` runs exactly once per turn, at the true end (both the direct-propose path and the
  post-resume path, since a resumed turn ends when `needs_clarification` is false). This
  appends the *current* turn so the *next* turn's `parse` sees it as prior context. `normalize`
  clears `clarification_answer` at the start of turn N+1 — which runs after turn N's
  `finalize`, so the answer is captured before it's cleared. (If a turn clarifies multiple
  rounds, `clarification_answer` is last-write-wins, so `finalize` records the final answer —
  acceptable for compact context.)

### 5. Prompt — `src/llm/prompt-builder.ts`

- Add the enriched view + history to the user payload:

  ```ts
  current_cart: input.current_cart,     // now CartView: line_id + name + keys + modifiers
  conversation_history: input.history,  // prior turns, oldest → newest
  ```

- Update the system text:
  - Note that each `current_cart` line carries `line_id`, `name`, `menu_item_key`, its current
    `modifiers`, and its `available_modifiers`; edits (`remove_item`/`update_quantity`/
    `add_modifier`/`remove_modifier`) **target the line's `line_id`**, and an
    `add_modifier`/`remove_modifier` `modifier_key` must be drawn from that line's
    `available_modifiers`/`modifiers` respectively.
  - Add a guardrail for history: *"`conversation_history` is prior turns, for resolving
    references like 'that' or 'the same' only. `current_cart` is the sole source of truth for
    what is in the order — never re-execute a past request from history."* This prevents the
    model re-adding items mentioned in earlier turns.

`buildRepairPrompt` needs no change (it composes `buildPrompt`).

---

## Tests

- **Unit — `buildCartView`** (new, deterministic, no live stack): a line with an attached
  modifier resolves to `{name, menu_item_key, modifiers:[{modifier_key,name}],
  available_modifiers:[…]}`; an unknown `product_tmpl_id` degrades to numeric fallback without
  throwing; an unknown `ptav_id` is dropped from `modifiers`.
- **Unit — history reducer** (mirror the Plan B `mergeCandidateLists` test): append order
  oldest→newest, cap keeps the newest `maxHistoryTurns`.
- **Unit — `order-understanding-service.test.ts`**: the fake `LlmProvider` only sees prompt
  strings, so existing tests keep passing; add one asserting a two-turn flow where turn 2's
  prompt (captured `user` string) contains turn 1's `customer_text` under
  `conversation_history`, and that a seeded line renders its `name`/`line_id` in `current_cart`.
- **e2e — `final-transcript.e2e.ts`**: the cross-turn test added for Plan B should now pass
  **without** relying on candidate survival. Consider tightening the `add_modifier`/
  `remove_modifier` self-skips into real assertions once the seeded line is self-describing
  (they should no longer depend on a dish-naming transcript). Keep them tolerant initially;
  tighten in a follow-up once observed stable.

---

## Knowledge base

- **`.claude/.knowledge/log.md`** — dated entry: what (self-describing cart view + persisted
  conversation history), why (deterministic multi-turn edits + reference resolution), where
  (`load-cart.node.ts`, `state.ts`, `build-graph.ts`, `prompt-builder.ts`,
  `order-graph-input.schema.ts`, `constants.ts`), notes (Plan A layered on Plan B; cart shape
  untouched; new `finalize` node).
- **`.claude/.knowledge/ordering/overview.md`** — update the graph description: node list now
  `normalize → load_cart → retrieve → parse → decide{clarify | finalize}`; `load_cart`
  produces an enriched `cart_view`; new `history` channel + `finalize` node; note the LLM now
  receives a self-describing cart and prior-turn context.

---

## Verification

1. `npx tsc --noEmit` — clean (watch the `current_cart: Cart → CartView` type change ripple
   through `toInput`, `buildPrompt`, and any test constructing `OrderGraphInput`).
2. `npm test` — green, including the new `buildCartView` and history-reducer unit tests.
3. `npm run test:e2e` (live Redis + Jina + Ollama) — the cross-turn edit test passes; the
   happy-path add/quantity/modifier tests still pass; watch for regressions from the larger
   prompt.
4. Sanity: confirm the enriched cart + history did not bloat the prompt enough to slow parse
   materially, and that the model does not re-apply history items (the guardrail line).

---

## Trade-offs & risks

- **Prompt size.** The view adds each line's `available_modifiers`, and history adds up to
  `maxHistoryTurns` short strings. Bounded, but larger than today; tune the caps if parse
  latency grows.
- **History misuse.** The model could treat a past utterance as a new command. Mitigated by
  the explicit guardrail line and by `current_cart` being the source of truth — verify in e2e.
- **Menu lookup cost.** One extra batched `getItems` per turn in `load_cart` (Redis reads,
  no vector search). Negligible relative to the LLM call.
- **Stale cart lines.** If a line references an item no longer in the menu, the view falls
  back to the numeric id as name — the model may struggle to reference it, but it won't throw.
- **Determinism.** Unlike Plan B, edits no longer depend on a candidate surviving the cap; the
  cart view is complete every turn. Plan B still helps for items discussed-but-not-yet-added.
```
