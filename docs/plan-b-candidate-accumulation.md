# Plan B — Accumulate candidates across turns

Implementation instructions for closing the **cross-turn modifier-edit gap** by making
the graph's `candidates` state channel accumulate across turns (instead of last-write-
wins), so a later turn's `parse` still sees the modifier keys of items surfaced earlier.

This is the lighter of two fixes. The heavier one — enriching `current_cart` with each
line's item name + `available_modifiers` — is **Plan A** and is tracked separately. Read
"Trade-offs" before choosing; Plan B is a heuristic, Plan A is deterministic.

---

## Background — the gap this closes

The Order Understanding graph runs, per fresh transcript:

```
START → normalize → load_cart → retrieve → parse
```

- `retrieve` (`src/ordering/nodes/retrieve-candidates.node.ts`) matches **only the current
  utterance** against the menu and writes the result to the `candidates` state channel.
- The `candidates` channel uses a **last-write-wins** reducer (`src/ordering/graph/state.ts`),
  so each turn's `retrieve` **overwrites** the previous turn's candidates before `parse`
  builds the prompt.
- A cart line in `current_cart` carries only numeric `product_tmpl_id` / `ptav_id` — no
  item name, no `modifier_key`, no `available_modifiers` (`src/cart/cart-types.ts`).
- The LLM call is stateless (`src/llm/openai-compatible-provider.ts` sends only
  `[system, user]` — no message history).

Net effect: on a turn like **"add broccoli to that"** (pronoun, no dish name), `retrieve`
does not surface the already-ordered item, so the model has **no valid `modifier_key`**
for the existing line and the edit fails/clarifies. See the `it.fails` test
`cross-turn modifier edit by reference` in `src/ordering/final-transcript.e2e.ts` and the
`log.md` entries dated 2026-07-08.

**Why accumulation fixes it:** the cart-keyed `MemorySaver` checkpointer already persists
the full graph state across turns (thread id `${pos_config_id}:${cart_id}`, see
`src/ordering/order-graph.ts`). If `retrieve` **merges** into the persisted `candidates`
instead of replacing them, the turn that first named "sweet and sour chicken" leaves its
candidate — **including its `available_modifiers` with the broccoli `modifier_key`** — in
state, and the later "add broccoli to that" turn's `parse` can see it.

---

## Scope

**In:**
- Change the `candidates` reducer from last-write-wins to a de-duplicating, size-capped
  merge.
- Add a cap constant.
- Flip the known-gap e2e test to a real assertion.
- Update the knowledge base.

**Out:**
- Plan A (cart enrichment). Do not touch `load-cart.node.ts`, `cart-types.ts`, or the
  cart-line shape.
- Prompt wording (`src/llm/prompt-builder.ts`) — already documents inline vs. edit
  modifiers; no change needed for Plan B.
- Any change to how `retrieve` matches (`menu.getCandidates` stays as is).

---

## Changes

### 1. Add a cap constant — `src/config/constants.ts`

Accumulated candidates must be bounded or the prompt grows without limit over a long
conversation. Add to `LIMITS`:

```ts
/** Plan B — max candidates retained across turns in graph state (bounds prompt growth). */
maxAccumulatedCandidates: 24,
```

Pick a value comfortably larger than `maxCandidatesToLlm` (8) so several turns' worth of
distinct items survive, but small enough to keep the prompt lean. 24 ≈ 3 turns of fresh
candidates. Tune later if needed.

### 2. Replace the reducer — `src/ordering/graph/state.ts`

The channel currently is:

```ts
candidates: lww<CandidateItem[]>(() => []),
```

Replace it with an accumulating reducer. Add a dedicated helper next to `lww` rather than
overloading `lww`:

```ts
import { LIMITS } from '../../config/constants.js';

/**
 * Accumulate candidates across turns (Plan B). `retrieve` writes only the current turn's
 * matches; merging them with the persisted set (newest first, de-duped by menu_item_key,
 * capped) lets a later turn edit an item surfaced by an earlier turn — the MemorySaver
 * checkpointer keeps the accumulated set alive on the cart-keyed thread. Pure + deterministic
 * (LangGraph requirement): no clocks, no randomness, stable ordering.
 */
function mergeCandidates() {
  return Annotation<CandidateItem[]>({
    reducer: (prev: CandidateItem[], next: CandidateItem[]) => {
      const seen = new Set<string>();
      const merged: CandidateItem[] = [];
      // `next` first so the current turn's items win the dedup and survive the cap.
      for (const c of [...next, ...prev]) {
        if (seen.has(c.menu_item_key)) continue;
        seen.add(c.menu_item_key);
        merged.push(c);
        if (merged.length >= LIMITS.maxAccumulatedCandidates) break;
      }
      return merged;
    },
    default: () => [],
  });
}
```

Then:

```ts
candidates: mergeCandidates(),
```

Dedup key rationale: `menu_item_key` is the stable catalog key (`src/menu/menu-types.ts`).
When the same item is surfaced again, the newer copy wins (it's in `next`), which refreshes
its `available_modifiers` from the store.

### 3. `retrieve` node — no change needed

`src/ordering/graph/build-graph.ts` already returns `{ candidates: candidates.items }`
from the `retrieve` node. With the new reducer this return value is now the `next`
argument and is merged rather than assigned. **Leave the node as is.** (Confirm the node
returns only the current match, not a pre-merged set — it does today.)

### 4. Watch the resume path

On a clarification **resume**, the graph re-enters at `clarify` → `parse` and does **not**
run `retrieve` (`build-graph.ts`), so the reducer is not called again mid-turn and no
duplication happens. No change needed, but keep this in mind when reasoning about state.

---

## Tests

### Flip the known-gap test — `src/ordering/final-transcript.e2e.ts`

The `it.fails('cross-turn modifier edit by reference ...')` case asserts the DESIRED
behavior and currently passes *because* it fails. After Plan B it should pass normally:

1. Change `it.fails(` → `it(`.
2. Update the block comment above it: remove the "KNOWN GAP / it.fails" explanation and
   describe it as verifying cross-turn candidate accumulation.
3. Keep the two-turn flow and both assertions as they are (they already assert the correct
   end state: `t2.name === 'cart.updated'` and the broccoli `ptav_id` on the seeded line).
4. Keep the widened `waitForAny` set and the 480_000 per-test timeout.

Note: this remains a real-stack, non-deterministic test. Accumulation makes the modifier
key *available*; the model must still choose to emit `add_modifier` with the right
`line_id`. If it proves flaky, downgrade the strict assertion to a self-skip on a
non-`cart.updated` outcome (mirroring the other tolerant edit tests) rather than deleting
coverage.

### Consider a unit test — `src/ordering/order-understanding-service.test.ts` or a new graph test

Add a deterministic test for the reducer semantics that does not need the live stack:
- Two `retrieve` writes with overlapping `menu_item_key`s → merged, deduped, newest-first.
- Writes exceeding `maxAccumulatedCandidates` → capped, oldest dropped.

If the reducer is hard to reach in isolation, export `mergeCandidates`'s inner merge
function (or a plain `mergeCandidateLists(prev, next, cap)` helper) and unit-test that
directly. Prefer the plain-helper shape so the logic is testable without LangGraph.

---

## Knowledge base

Per `.claude/CLAUDE.md`:
- **`.claude/.knowledge/log.md`** — add a dated entry: what (candidates now accumulate),
  why (cross-turn modifier edits), where (`state.ts`, `constants.ts`, e2e test), notes
  (Plan B chosen over Plan A; heuristic bound by cap + recency).
- **`.claude/.knowledge/ordering/overview.md`** — update the graph/state description if it
  documents the `candidates` channel or the retrieve→parse behavior, so it reflects
  accumulation rather than per-turn replacement.

---

## Verification

1. `npx tsc --noEmit` — clean.
2. Unit tests: `npm test` (or the project's unit script) — green, including the new
   reducer test.
3. Real-stack e2e (needs live Redis + Jina + Ollama; ~minutes per turn):
   `npm run test:e2e` — the formerly-`it.fails` cross-turn test now passes as a normal
   `it`, and the existing add/edit tests still pass.
4. Sanity: confirm `add_item` accuracy did not regress — accumulated candidates add
   distractor items to the prompt for later turns (see Trade-offs). Watch the happy-path
   and quantity tests.

---

## Trade-offs & risks

- **Heuristic, not guaranteed.** Accumulation only helps if the edited item's candidate is
  still within the cap (recency + `maxAccumulatedCandidates`). Edit an item surfaced many
  turns and many items ago and it may have been evicted — the gap reopens. Plan A does not
  have this failure mode.
- **Prompt noise for `add_item`.** Later turns now see items from earlier turns that are
  irrelevant to the current utterance, which can bias `add_item` toward a stale match.
  Mitigated by the cap and by `next`-first ordering; if it bites, lower the cap.
- **Cross-utterance leakage within a session** is intended here, but verify it does not let
  the model re-add or mis-target items. The `current_cart` + line_id remain the source of
  truth for edits; candidates only supply keys.
- **Per-cart memory.** `MemorySaver` is in-process; accumulated candidates live for the
  cart thread's lifetime. This is bounded by the cap and cleared when the process/thread
  goes away. No persistence-store change.

## If Plan B proves too flaky

Escalate to **Plan A** (enrich `current_cart` with per-line item name +
`available_modifiers` + resolved `ptav_id`→`modifier_key`, passed through `buildPrompt`).
It is deterministic and also fixes line identification ("the chicken" → `line_id`), at the
cost of touching `load-cart.node.ts`, a prompt-facing view type, and `prompt-builder.ts`.
Plan A and Plan B are compatible and can be shipped together.
