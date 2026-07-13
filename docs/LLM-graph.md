# Order Understanding — LangGraph Internals

A deep reference for the `@langchain/langgraph` graph that turns a final transcript
into proposed cart operations (or a clarification request). Covers the graph
topology, every state channel, the interrupt/resume mechanism, the checkpointer
thread model, and error handling.

Scope: `src/ordering/graph/` (`build-graph.ts`, `state.ts`, `instrument.ts`),
`src/ordering/order-graph.ts` (the façade), and the `src/ordering/nodes/*` invoked
by the graph. The service loop that *drives* the graph
(`order-understanding-service.ts`) is covered only where it touches graph behavior —
see `ordering/overview.md` for the surrounding module.

---

## 1. Where the graph sits

```
stt.final_transcript.received
        │
        ▼
OrderUnderstandingService.handleFinalTranscript
        │  (Tier-1 per-cart FIFO — CartTurnQueue serializes turns per cart_id)
        ▼
OrderGraph.start()  ──►  graph.invoke(input, threadConfig)
        │                         │
        │                         ▼
        │              ┌──────────────────────┐
        │              │ LangGraph StateGraph │  ← this document
        │              └──────────────────────┘
        ▼
GraphTurnResult: { status: 'complete', output, base_version }
             or  { status: 'clarify', question, options? }
```

The graph is a **pure proposer**. It never mutates the cart; it reads the cart
snapshot, asks the LLM for operations, validates their *shape*, and returns them.
Business validation (does the key exist, is the item available) is the Cart
Validator's job downstream.

---

## 2. Graph topology

Defined in `graph/build-graph.ts` → `buildOrderGraph({ menu, llm, carts })`.

```
 START
   │
   ▼
 normalize
   │
   ▼
 classify ──(INTENT_ROUTE, one conditional edge)──┐
   │ order            │ suggest          │ junk
   ▼                  ▼                  ▼
 load_cart          suggest             END   (junk not recorded)
   │                  │
   ▼                  │
 retrieve ──► parse ──┤
                      ▼
                   finalize ──► END
```

- **`normalize` is the entry point**; **`classify` runs right after it** (design §6) and labels
  the NORMALIZED utterance `order | suggest | junk`, routing via a single conditional edge whose
  path map is `INTENT_ROUTE` (`graph/intents.ts`). The router returns `s.intent`; `INTENT_ROUTE`
  maps it to the next node, so routing and the intent set can't drift.
  - `order` → `load_cart` (the rest of the proposer spine — `normalize` already ran).
  - `suggest` → the `suggest` recommender node → `finalize`.
  - `junk` → `END` directly.
- Order spine: `normalize → classify → load_cart → retrieve → parse → finalize`. A clarification
  is not a branch/pause — `parse` sets `needs_clarification` and `finalize` records the question;
  the order path always runs to `END`.
- `finalize → END` records the completed turn to history. The `order` and `suggest` routes pass
  through it; **`junk` skips it and goes straight to `END`**, so a non-orderable utterance
  (greeting, noise) is never recorded and can't pollute the context later fed to `parse`.
- Non-order intents **skip the proposer `parse`**: `junk` touches nothing; `suggest` loads the
  cart and retrieves candidates inside its own node (for the recommendation) but never runs the
  `parse`/repair pipeline, so no cart operations are ever proposed for them.
- **Extensibility:** adding an intent is a one-row edit — a value in `intentSchema` and a row in
  `INTENT_ROUTE` (+ a handler node only if it needs its own behavior).

Compiled with `.compile({ checkpointer: new MemorySaver() })` — the checkpointer is
what makes pause/resume possible (§5).

### The `node()` wrapper

Every node is wrapped by `graph/instrument.ts` → `node(name, fn)`:

- Runs `fn(state)`; on throw, logs `order.node_failed` **once** with `{ node,
  request_id, cart_id, pos_config_id, ...errorMeta }`, then re-throws unchanged.
- Uses `isGraphBubbleUp(error)` to pass LangGraph's own control-flow throws
  (interrupt/pause, `Command` bubbling) straight through **without** logging them as
  errors — an `interrupt()` is not a fault.
- This centralizes per-node error attribution so a Redis failure in `load_cart`
  isn't mislabeled as a parse failure by the single catch in the service.

---

## 3. State channels (`graph/state.ts`)

State is an `Annotation.Root`. Two reducer strategies are used:

### `lww` — last-write-wins with a default

```ts
function lww<T>(def: () => T) {
  return Annotation<T>({ reducer: (_prev, next) => next, default: def });
}
```

A node returning the channel overwrites it; a node that doesn't touch it leaves the
prior value. The `default` lets a channel be *read* before it's ever written.

### `appendHistory` — accumulating, capped

```ts
reducer: (prev, next) => mergeHistory(prev, next, LIMITS.maxHistoryTurns)
```

`mergeHistory(prev, next, cap) = [...prev, ...next].slice(-cap)` — appends the
completed turn(s) and keeps only the newest `cap` (currently
`LIMITS.maxHistoryTurns = 6`), oldest→newest. Extracted as a pure function so its
semantics are unit-testable without LangGraph (LangGraph requires reducers to be
pure + deterministic).

### Channel table

| Channel | Reducer | Default | Written by | Purpose |
|---|---|---|---|---|
| `request_id` | plain | — | invoke input | turn correlation id |
| `session_id` | plain | — | invoke input | voice session id |
| `cart_id` | plain | — | invoke input | cart being ordered against |
| `pos_config_id` | plain | — | invoke input | POS/menu scope |
| `customer_text` | plain | — | invoke input, then `normalize` | the utterance |
| `intent` | lww | `'order'` | `classify` | routing label (`order`/`suggest`/`junk`) |
| `language` | lww | `undefined` | invoke input | optional lang hint |
| `supported_languages` | lww | `[]` | invoke input | allowed langs (currently `[]`, TODO) |
| `clarification_answer` | lww | `undefined` | `clarify` (set), `normalize` (clear) | one-shot answer for the resumed parse |
| `clarification_question` | lww | `undefined` | `clarify` (set), `normalize` (clear) | kept so `finalize` can log Q with A |
| `cart_view` | lww | `null` | `load_cart` | self-describing cart projection for the prompt |
| `base_version` | lww | `0` | `load_cart` | cart version the proposal is computed against |
| `candidates` | lww | `[]` | `retrieve` | per-turn candidate items for the prompt |
| `history` | append (capped) | `[]` | `finalize` | prior turns, resent for reference resolution |
| `output` | lww | `null` | `parse` (set), `clarify` (clear to `null`) | the parsed LLM result |
| `suggestion` | lww | `null` | `suggest` (set), `normalize` (clear to `null`) | `{ reply, items }` recommendation for a `suggest` turn |

Three lifetimes are in play:

1. **Durable across turns** (survive many invokes on the same thread):
   `history`, plus all the input ids. Carried by the checkpointer thread.
2. **Per-turn** (recomputed each fresh turn): `cart_view`, `base_version`,
   `candidates`, `output`, normalized `customer_text`.
3. **One-shot within a turn**: `clarification_answer` / `clarification_question` —
   set on `clarify`, consumed by the very next `parse`, and cleared by `normalize`
   at the start of the *next* fresh turn so a prior turn's answer can never leak
   into a new turn's prompt (§4, `normalize`).

---

## 4. Nodes, one by one

### `classify`

```ts
if (s.clarification_question !== undefined) return { intent: 'order' as const };
const intent = await classifyIntent(intentLlm, s.customer_text);
return { intent };
```

- Runs **right after `normalize`** (not the entry point). Sets the `intent` channel, which the
  conditional edge reads to route the turn (§2). Classifies the NORMALIZED utterance.
- **Pending-clarification override:** `normalize` carries an unanswered `clarification_question`
  from the last history turn into the channel; if it's set, THIS utterance is that answer, so
  `classify` forces `intent = 'order'` and skips the classifier LLM call entirely — the parse
  pipeline resolves the question. Without this, a terse answer ("both", "the second one") could be
  mislabeled `junk` and dropped.
- `classifyIntent` (`nodes/classify-intent.node.ts`) calls its OWN LLM provider (`intentLlm`,
  built from `INTENT_LLM_*` env by `createIntentLlmProvider`, falling back to `LLM_*` — so the
  classifier can run on a cheaper/separate model+key than the parser) with `buildIntentPrompt`
  (`llm/intent-prompt-builder.ts`), JSON-parses, and validates against `intentSchema`. It
  **degrades to `order` on any failure** (transport error, non-JSON, non-object payload, unknown
  label): a real order must never be dropped. The `stub` provider returns a non-intent JSON, so it
  always degrades to `order` — i.e. stub deployments behave exactly as before this node existed.

### `normalize`

```ts
customer_text: normalizeTranscript(s.customer_text),
clarification_answer: undefined,
clarification_question: undefined,
```

- `normalizeTranscript` (`nodes/normalize-transcript.node.ts`) is just
  `text.trim().replace(/\s+/g, ' ')` — collapse whitespace.
- **Critically, it clears the clarification channels.** `normalize` runs only on a
  *fresh* turn (entered from `START`). A resume re-enters the graph at `clarify`
  (§5), so it skips `normalize` — meaning a within-turn answer survives to `parse`,
  but a stale answer from a *previous* completed turn is wiped before a new turn
  parses. This is the mechanism that keeps the one-shot channels one-shot.

### `load_cart`

```ts
const cart = await loadCart(carts, s.cart_id, s.pos_config_id);
const cart_view = await buildCartView(menu, cart);
return { cart_view, base_version: cart.version };
```

- `loadCart` reads the cart from `CartCache`, falling back to `emptyCart(...)` when
  absent — a first turn on a new cart still gets a valid (empty) snapshot.
- `base_version` is captured here as `cart.version` and then **rides through
  resumes untouched** (lww, not rewritten by later nodes), so the eventual proposal
  always carries the version it was computed against — the basis for optimistic
  concurrency downstream (design §9).
- `buildCartView` (Plan A) projects the stored cart into a **self-describing**
  `CartView`: one batched `menu.getItems` read resolves each line to its `name` +
  `menu_item_key`, maps each attached `ptav_id` to `{modifier_key, name}`, and lists
  the item's `available_modifiers`. Numeric `product_tmpl_id`/`ptav_id` are
  deliberately **omitted** so the model can't confuse one for a `line_id`. It
  degrades gracefully (numeric-id fallback for name/key, dropped unknown modifiers)
  so a stale cart line never throws.

### `retrieve`

```ts
const candidates = await retrieveCandidates(menu, s.pos_config_id, s.customer_text);
return { candidates: candidates.items };
```

- Thin wrapper over `menu.getCandidates(pos_config_id, text)` (design §7) — the
  likely items/modifiers for this utterance, capped at `LIMITS.maxCandidatesToLlm`
  (8) inside the menu module.
- lww: `retrieve` fully replaces `candidates` every turn; they are never
  accumulated (superseding the removed Plan B candidate-accumulation approach —
  cart-resident vocabulary now comes from `cart_view`).

### `parse`

```ts
const output = await parseAndValidate(llm, toInput(s), LIMITS.llmMaxRetries);
return { output };
```

- `toInput(s)` assembles the `OrderGraphInput` from state: ids, normalized
  `customer_text`, `current_cart: cart_view!`, `candidate_items`, `history`,
  `supported_languages`, and — **only when present** — `language` and
  `clarification_answer`. The clarification answer being in the input is what lets
  the resumed parse honor the customer's answer.
- `parseAndValidate` (`nodes/parse-and-validate.node.ts`) is the schema-repair loop:
  1. `parseOrder(llm, input)` → raw JSON string (`buildPrompt`).
  2. `validateOperations(raw)`: `JSON.parse` then zod
     `parseOrderGraphOutput`; returns a `Result`.
  3. On success → return the validated `OrderGraphOutput`.
  4. On failure, if attempts `< maxRepairs` (`LIMITS.llmMaxRetries = 1`), log
     `order.schema_repair_retry` and re-prompt with `buildRepairPrompt(input, raw,
     error.message)` — the rejected output plus the validation error — then loop.
  5. On exhaustion, log `order.schema_repair_exhausted` and **throw** the last
     `ValidationError`. The throw propagates out of the node → out of `invoke()` →
     the service fails the turn with `order_parse_failed` (§7).
- Net: one parse attempt + up to one repair re-prompt (2 LLM calls worst case)
  before the turn fails.

### `clarify`

```ts
const out = s.output!;
const payload: ClarificationInterrupt = {
  question: out.clarification_question!,
  ...(out.clarification_options !== undefined ? { options: out.clarification_options } : {}),
};
const answer = interrupt(payload) as string;
return { clarification_answer: answer, clarification_question: payload.question, output: null };
```

- Reached only when `parse` produced `output.needs_clarification === true`. The
  output schema `.refine(...)` guarantees a non-null `clarification_question`
  accompanies that flag, so the `!` is safe.
- `interrupt(payload)` **pauses the graph** (§5). On the first pass, control leaves
  the graph and `invoke()` returns with `__interrupt__` populated. On resume, the
  node body re-runs from the top and `interrupt(...)` *returns* the supplied answer.
- On resume it: stores the answer (`clarification_answer`), keeps the question
  (`clarification_question`, so `finalize` can log the Q/A pair as history context),
  and **clears `output` to `null`** so the stale clarify-output can't be mistaken
  for a completed proposal. Then the `clarify → parse` edge re-parses.

### `finalize`

```ts
history: [{
  customer_text: s.customer_text,
  ...(s.clarification_question !== undefined ? { clarification_question: s.clarification_question } : {}),
  ...(s.clarification_answer  !== undefined ? { clarification_answer:  s.clarification_answer  } : {}),
}]
```

- The single terminus before `END`. Appends **one** `HistoryTurn` for the whole
  turn — the utterance plus, if the turn was clarified, the question and answer.
- `history`'s appending+capped reducer means the next turn's `parse` re-sends the
  newest ≤6 turns as conversation context so references ("that", "the same one")
  resolve. History is **reference-only** — the prompt forbids re-executing a past
  request; `current_cart` is the source of truth for what's actually in the cart.
- Reached by the order path AND by the `suggest` route, so those turns are recorded once. For a
  `suggest` turn `output` is `null`, so no clarification is recorded — just the utterance. The
  `junk` route skips `finalize` entirely (routes straight to `END`), so a non-orderable utterance
  is **not** recorded — it can't pollute the context later fed to `parse`.

### `suggest`

```ts
const cart = await loadCart(carts, s.cart_id, s.pos_config_id);
const cart_view = await buildCartView(menu, cart);
const candidates = await retrieveCandidates(menu, s.pos_config_id, s.customer_text);
const suggestion = await generateSuggestion(llm, { customer_text, current_cart: cart_view,
  candidate_items: candidates.items, history, language? });
return { suggestion };
```

- The recommender for the `suggest` intent (`nodes/suggest.node.ts` → `generateSuggestion`). It
  loads the cart (for upsell context) and retrieves this turn's candidates, then asks the proposer
  `llm` (via `buildSuggestionPrompt`) for a `{ reply, items }` and validates it with
  `parseSuggestion`. Recommended items are **filtered to the candidates**, so the model can't
  surface anything off-menu. It **degrades to a safe fallback reply** (empty items) on any failure
  — a bad recommendation must not fail the turn.
- Writes the result to the `suggestion` state channel. `OrderGraph.interpret` reads both the
  `intent` and this channel → `{ status: 'suggest', reply, items }`; the service emits
  `order.suggestion_ready`.
- `finalize` records `suggestion.items` into the turn's `HistoryTurn.suggested_items`, so a
  follow-up ("the first one", "add that") resolves against them on the next turn's `parse` (the
  parse prompt permits a recalled suggested key even when it's not in that turn's candidates).
  `normalize` clears the `suggestion` channel each fresh turn so a prior suggestion can't leak
  into a later order turn's `finalize`.

---

## 5. Pause / resume: the interrupt mechanism

This is the heart of the clarification loop and the main reason a checkpointer is
required.

### First pass (pause)

1. `parse` sets `output.needs_clarification = true`; the conditional edge routes to
   `clarify`.
2. `clarify` calls `interrupt(payload)`. LangGraph throws a control-flow signal
   (recognized by `isGraphBubbleUp`, so `node()` doesn't log it as an error) that
   bubbles out of `invoke()`.
3. The checkpointer **persists the full state** at the `clarify` boundary under the
   thread id.
4. `invoke()` resolves with `{ ..., __interrupt__: [{ value: ClarificationInterrupt }] }`.

### Interpretation (`order-graph.ts`)

`OrderGraph.interpret(out)`:

```ts
const first = out.__interrupt__?.[0];
if (first !== undefined) return { status: 'clarify', question, options? };
return { status: 'complete', output: out.output!, base_version: out.base_version };
```

- `__interrupt__` present → `{ status: 'clarify', ... }`.
- Absent → the graph ran to `END`, so `output` is set → `{ status: 'complete',
  output, base_version }`.

### Resume

`OrderGraph.resume(pos_config_id, cart_id, answer)`:

```ts
await this.graph.invoke(new Command({ resume: answer }), this.threadConfig(...));
```

- `new Command({ resume: answer })` tells LangGraph to reload the checkpointed
  state for the thread and continue **from the interrupt point**.
- `clarify` re-runs; `interrupt(...)` now returns `answer`. The node writes
  `clarification_answer`, and `clarify → parse` re-parses with the answer in the
  input.
- The resumed run re-enters at `clarify`, **not** `START`, so `normalize` does not
  run — which is exactly why the one-shot `clarification_answer` survives to this
  parse but is cleared before any *future* fresh turn.
- From there the turn either completes (`finalize → END`) or clarifies again
  (bounded by the service's round cap).

### Why the checkpointer / thread id matters

```ts
threadConfig = { configurable: { thread_id: `${pos_config_id}:${cart_id}` } };
```

- The thread id keys on **`pos_config_id:cart_id`**, so conversational context
  (history, and any paused turn) follows the **cart**, not a single voice session.
  Multiple sessions on the same cart share memory (design §6).
- `MemorySaver` is **in-process only** — durable across invokes within a running
  process, but *not* across restarts. A crash between pause and resume loses the
  paused turn. A durable checkpointer (Redis/Postgres) is a noted future upgrade.

---

## 6. What is persisted vs. what is sent to the LLM each turn

Three distinct sets are easy to conflate. The checkpointer persists the *entire*
state blob per thread, but that is not the same as what carries forward across
turns, which is not the same as what the model actually reads.

> **Scope note:** the third set below is rendered in `src/llm/prompt-builder.ts`
> (`buildPrompt`), which is outside this doc's core scope but is the authoritative
> last hop — `toInput` (§4 `parse`) produces the `OrderGraphInput`, and `buildPrompt`
> decides which of its fields reach the model.

### 6.1 Persisted across turns (survives to influence the *next* fresh turn)

The `MemorySaver` checkpoint holds the whole `OrderState` per thread, but on a fresh
turn (entered at `START`) almost every channel is overwritten — by the invoke input
(ids, `customer_text`, `supported_languages`, optional `language`) or by the nodes
(`cart_view`/`base_version` in `load_cart`, `candidates` in `retrieve`, `output` in
`parse`, clarification channels cleared in `normalize`). The one channel with an
**append** reducer, and thus the only meaningful cross-turn carryover, is:

- **`history`** — the `finalize`-appended `HistoryTurn[]`, capped at
  `LIMITS.maxHistoryTurns = 6` (oldest→newest). Everything else is effectively
  per-turn even though it is checkpointed.

(Within a *single* paused turn, the checkpoint additionally preserves the live
`clarification_answer`/`clarification_question`/`output` across the interrupt — see
§5 — but those are cleared before the next fresh turn.)

### 6.2 Recomputed every turn (not carried forward)

`customer_text` (normalized), `cart_view`, `base_version`, `candidates`, `output`,
and the input ids (re-supplied on each invoke). `base_version` is captured at
`load_cart` and returned in the `complete` result, but it is **not** sent to the LLM.

### 6.3 Actually sent to the LLM

`toInput` builds an `OrderGraphInput` with: `request_id`, `session_id`, `cart_id`,
`pos_config_id`, `customer_text`, `current_cart`, `candidate_items`, `history`,
`supported_languages`, and — only when present — `language`,
`clarification_answer`, and `clarification_question`.

`buildPrompt` then forwards only a **subset** into the user-message JSON. The
clarification answer and its question are rendered together as a single nested
`clarification` object so the model sees them as a pair:

```jsonc
{
  "request_id":           "...",
  "customer_text":        "...",          // normalized utterance
  "language":             "...",          // if present
  "current_cart":         { ... },        // self-describing CartView
  "candidate_items":      [ ... ],        // this turn's retrieval
  "conversation_history": [ ... ],        // = state `history`, RENAMED
  "clarification": {                      // present only on a resumed turn
    "question":           "...",          // = state `clarification_question`
    "answer":             "..."           // = state `clarification_answer`
  }
}
```

Plus a **static system prompt** (operation rules + allowed-operation list derived
from `cartOperationSchema`).

| `OrderGraphInput` field | Reaches the LLM? | Notes |
|---|---|---|
| `request_id` | yes | correlation only |
| `customer_text` | yes | the utterance |
| `language` | yes (if set) | |
| `current_cart` | yes | source of truth for what's in the cart |
| `candidate_items` | yes | |
| `history` | yes → as **`conversation_history`** | reference-only |
| `clarification_answer` | yes (resume only) | rendered inside the `clarification` object |
| `clarification_question` | yes (resume only) | rendered inside the `clarification` object |
| `session_id` | **no** | dropped by `buildPrompt` |
| `cart_id` | **no** | dropped |
| `pos_config_id` | **no** | dropped |
| `supported_languages` | **no** | dropped |
| `base_version` | **no** | graph-internal; rides resumes, returned in result |

### 6.4 The clarification loop and the remaining prompt gap

A resumed turn used to re-emit the *same* `clarification_question` — the observable
`clarification_needed → answered → clarification_needed` loop, bounded by
`MAX_CLARIFICATION_ROUNDS`. Two things drove it; one is now fixed:

1. **~~`clarification_question` is never sent.~~ Fixed.** The question is now threaded
   `state → toInput → OrderGraphInput → buildPrompt` and rendered in the nested
   `clarification` object alongside the answer, so on a resumed turn the model sees
   the question it asked paired with the customer's reply. (Previously the Q/A pair
   only entered `conversation_history` *after* `finalize`, which has not run for the
   in-flight turn.)
2. **Still open — the system prompt does not document `clarification`.** The object
   now appears in the user JSON, but no instruction tells the model it is its prior
   question plus the customer's reply, to resolve the order from it, and not to
   re-ask. Until that one prompt line is added, a resumed `parse` can still re-read
   the ambiguous `customer_text` and ask again — the plumbing gives the model the
   context, but not yet the instruction to use it.

---

## 7. Output contract & failure modes

`schemas/order-graph-output.schema.ts` (zod):

```ts
operations:            z.array(cartOperationSchema).default([]),
needs_clarification:   z.boolean().default(false),
clarification_question:z.string().nullable().default(null),
clarification_options: z.array(z.string()).optional(),
// .refine: needs_clarification=true  ⇒  clarification_question !== null
```

- Lenient defaults mean a minimal `{}` from the model still validates as
  "propose nothing." The `.refine` is the one hard cross-field rule: you cannot ask
  for clarification without a question.
- `parseOrderGraphOutput` returns a `Result`; on failure it carries a
  repair-friendly message from `formatZodError` (`zod-error.ts`) that feeds
  straight back into the repair prompt.

How the graph turn can end:

| Outcome | Trigger | Surfaced as |
|---|---|---|
| Proposal | `parse` → `finalize → END`, `output.operations` | `GraphTurnResult.complete` → `order.operations_proposed` |
| Clarification | `parse` → `clarify` → `interrupt` | `GraphTurnResult.clarify` → service emits `order.clarification_needed` |
| Parse failure | repair loop exhausted → `parse` throws | node logs `order.node_failed`; `invoke()` rejects → service `voice.session_failed` (`order_parse_failed`) |
| Node fault | any node throws (e.g. Redis in `load_cart`) | `order.node_failed` (tagged with node) → `invoke()` rejects → service fails the turn |

Two service-level guards wrap the graph (outside this doc's scope, but they bound
the loop): a `TIMEOUTS.clarificationMs = 30_000` stall timeout and a
`MAX_CLARIFICATION_ROUNDS = 3` cap. See `ordering/overview.md` §Clarification.

---

## 8. Invariants worth preserving

1. **`finalize` is the only path to `END`.** Both propose and post-clarify routes
   pass through it, so history is recorded exactly once. Don't add an edge that
   skips it.
2. **`normalize` runs only on fresh turns and must clear the clarification
   channels.** This is what makes `clarification_answer` one-shot. Resumes
   intentionally bypass it.
3. **`base_version` is captured once at `load_cart` and never rewritten.** It must
   ride resumes unchanged so the proposal's version matches the snapshot it was
   computed from.
4. **`clarify` must null out `output`.** Otherwise the stale clarify-output could be
   read as a completed proposal after resume.
5. **Reducers stay pure/deterministic** (LangGraph requirement) — see the extracted
   `mergeHistory`.
6. **No numeric ids in the prompt-facing views.** `cart_view` exposes
   keys/names/`line_id` only, by design, so the model can't confuse a
   `product_tmpl_id`/`ptav_id` for a `line_id`.

---

## 9. File map

| File | Role |
|---|---|
| `order-graph.ts` | Façade: `start()` / `interpret()`, thread config; maps intent → `GraphTurnResult`. |
| `graph/build-graph.ts` | Node definitions, edges, intent routing, compile+checkpointer. |
| `graph/intents.ts` | `intentSchema` + `INTENT_ROUTE` — the intent set and its routing table. |
| `graph/state.ts` | `OrderState` annotations, `lww`/`appendHistory` reducers, `mergeHistory`. |
| `graph/instrument.ts` | `node(name, fn)` — per-node error logging, bubble-up passthrough. |
| `nodes/classify-intent.node.ts` | LLM intent classifier; defaults to `order` on any failure. |
| `nodes/suggest.node.ts` | `generateSuggestion` — LLM recommender for the `suggest` intent; filters to candidates, degrades to a fallback reply. |
| `schemas/suggestion.schema.ts` | `Suggestion`/`SuggestedItem` types + `parseSuggestion` (zod). |
| `nodes/normalize-transcript.node.ts` | Whitespace normalization. |
| `nodes/load-cart.node.ts` | `loadCart` + `buildCartView` (self-describing projection). |
| `nodes/retrieve-candidates.node.ts` | Candidate retrieval wrapper. |
| `nodes/parse-order.node.ts` | Single LLM parse call. |
| `nodes/validate-operations.node.ts` | JSON + zod validation → `Result`. |
| `nodes/parse-and-validate.node.ts` | Parse + schema-repair retry loop. |
| `schemas/order-graph-input.schema.ts` | `OrderGraphInput`, `CartView`, `HistoryTurn` types. |
| `schemas/order-graph-output.schema.ts` | Output zod schema + `parseOrderGraphOutput`. |
