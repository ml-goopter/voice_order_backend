---
type: Concept
title: Order Understanding (LangGraph-style)
description: Serialized per-cart turns → agent tool-calling loop → operations_proposed / reply.
resource: src/ordering
timestamp: 2026-07-22
---

# Order Understanding

## Purpose
Turns `stt.final_transcript.received` into an `OrderProposal` (operations +
`base_version`) **and/or** an `order.reply` (a spoken clarification/recommendation/confirmation),
design §6. A `propose_cart` may bundle a spoken confirmation, so one turn can emit BOTH events.
A reply may also carry the menu items it named (`mentioned_items`), verified against the turn's own
searches. It is a **pure proposer**; the Cart Module validates and applies.

## Mechanics
- **Tier-1 per-cart FIFO** (`cart-turn-queue.ts`, backed by `shared/async-lock`):
  final transcripts for one `cart_id` run one turn at a time in arrival order, so
  turn 2 sees turn 1's result and loads a fresh `base_version` (design §9). Sits
  **in front of** the graph.
- **Graph** (`order-graph.ts` + `graph/`) is a real `@langchain/langgraph`
  `StateGraph` implementing an **agent tool-calling loop** (docs/agent-tools.md), NOT a
  fixed retrieve→parse pipeline: `normalize → classify → load_cart → agent ⇄ tools →
  finalize → END`.
  - **classify** is a **binary junk-gate** only. It labels the utterance `service`/`junk`
    via a cheap first-hop LLM call on its OWN provider/creds (`INTENT_LLM_*` env, falling
    back to `LLM_*`; `createIntentLlmProvider` → `GraphDeps.intentLlm` →
    `nodes/classify-intent.node.ts`), routing via the one table-driven conditional edge
    `INTENT_ROUTE` (`graph/intents.ts`, single source of truth). `service` — anything a
    server could act on (ordering, edits, recommendations, menu questions) — routes into the
    pipeline (`load_cart` → `agent`), where the agent decides the outcome; `junk` → straight
    to `END` (a non-orderable utterance is NOT recorded to history, so it can't pollute later
    context). **The set is binary because that is the only distinction anything downstream
    reads:** `interpret` only asks `intent === 'junk'`, and the agent works out what the
    customer wants on its own, so a finer label (the former `order`/`suggest` split) routed
    identically and was consumed by no one. The classifier DEGRADES to `service` on any
    failure (so a real order is never dropped; the `stub` provider therefore always yields
    `service`). When the previous turn ended in a spoken reply (the last `history` entry has
    `agent_reply`), classify **forces `service`** and skips the LLM call, so a terse
    follow-up isn't misrouted to junk.
  - **agent** (`nodes` inline in `build-graph.ts`) runs one LLM tool-calling turn via
    `LlmProvider.chat`. On first entry it seeds the transcript with the system prompt +
    user context (`buildAgentMessages` in `llm/agent-prompt-builder.ts`: `customer_text`,
    `current_cart`, `conversation_history` — candidates are NOT pre-fetched). It ends the
    turn one of two ways: by calling **`propose_cart`** (structured operations — which MAY also
    bundle a short spoken `reply`/`language` to confirm/suggest while committing, approach B), or by
    **replying** (no tool call) — a single "reply" outcome serving as both a clarifying question
    and a recommendation. When the turn has anything to commit it MUST end with `propose_cart`
    (words go in its `reply`); a standalone reply is only for turns with nothing to commit, so
    `propose_cart` is always the last tool call. A standalone reply is strict JSON `{language, reply, mentioned_items?}` parsed by
    `graph/parse-agent-reply.ts`, which writes the agent-declared language onto the turn-scoped
    `reply_language` channel (cleared by `normalize`, so a declaration never outlives its turn) —
    the ONLY source of the reply's language, defaulted to `TTS_LANGUAGE` by the façade (the sole
    `speak` caller, so that is where the knob is applied). The graph takes no
    STT `language` input at all. That parser degrades PER-FIELD — non-JSON text is spoken as-is, an
    off-format `language` costs only the language — so a format slip never drops a reply.
    Bounded by `LIMITS.maxAgentSteps` (8, sized to allow several sequential per-item searches
    before a propose); exhaustion → `failure_reason='agent_step_limit'`; an empty reply, or a
    JSON blob carrying no usable `reply`, → `agent_no_terminal`.
  - **tools** (`tools/run-tools.ts`) executes the requested tool calls, appends their
    results to the turn scratchpad, and loops back to the agent. Two tools
    (`tools/tool-specs.ts`): `search_menu` (wraps `menu.searchMenu`, loopable — takes
    `{query?, sort?, max_price_cents?, min_price_cents?, limit?}`; every field optional, so an
    argument-less call is a valid "what's popular?" browse. Filters/sort are one tool rather
    than the `filter_menu` + `popular_items` pair docs/agent-tools.md §2 sketched, so that
    "popular AND has fish" is intersected server-side instead of by the model)
    and `propose_cart` (validates args against `order-graph-output` zod schema; a failure —
    including an **empty/absent `operations`** list — is a repair-friendly **tool error** the
    agent retries within `maxAgentSteps`, rather than a silent empty proposal; this replaces
    the old separate schema-repair round). Beyond the shape, `propose_cart` also enforces
    **required modifier groups** (`tools/required-modifiers.ts`): a group with `required: true`
    (`display_type <> 'multi'`) must end up holding EXACTLY one option, or the call is another
    retriable tool error. This business check lives here rather than in the Cart Validator on
    purpose — a tool error re-enters the agent loop, so the agent can ASK the customer inside the
    SAME turn, whereas a `cart.operation_rejected` would land after the turn ended. A successful `propose_cart` writes the `output`
    channel and ends the loop; its optional `reply`/`language` args (parsed by the shared
    `parseAgentReply` from `parse-agent-reply.ts` — the same function the standalone spoken
    terminal uses, so a blank reply or off-format code degrades identically on both paths)
    additionally write `reply`/`reply_language` alongside `output`.
  - **finalize** records the completed turn to `history`: always `customer_text`, plus
    `agent_reply` when the agent ended by speaking (so the next turn has the context and
    force-orders). Committed/failed turns record only the utterance.
- **State** (`graph/state.ts`, `Annotation.Root`, last-write-wins with defaults):
  `base_version` captured at `load_cart` (= `cart.version`). The agent's terminal channels are
  `output` (propose_cart) and `reply` (spoken) — **no longer mutually exclusive**: a `propose_cart`
  may set both (commit + bundled confirmation). Turn-scoped
  channels reset by `normalize` each turn (the checkpointer persists everything, so anything
  left would leak): `output`, `reply`, `agent_messages` (the tool-calling scratchpad — NEVER
  persisted across turns), `agent_steps`, `token_usage`, `failure_reason`, `search_results`
  (`menu_item_key` → `MentionedItem` for everything this turn's searches returned, accumulated
  across agent steps; it is what a declared `mentioned_items` key is verified against, so it must
  only ever hold THIS turn's searches), and `mentioned_items` (the verified items for this reply). `token_usage`
  accumulates each agent `chat` call's `LlmUsage` (read-modify-write in the `agent` node, like
  `agent_steps`); after `invoke`, `OrderGraph.start` reads the final `TurnUsage` and emits an
  `llm.turn_usage` INFO rollup tagged with `request_id`/`cart_id`/`pos_config_id` + the parser
  model (steps, summed tokens, blended `cache_hit_rate`). Nodes stay pure — the log is a
  side-effect in the façade; junk turns (agent never ran) emit nothing. Two channels carry across
  turns:
  - **`cart_view`** (Plan A): `load_cart` projects the stored cart into a self-describing
    `CartView` (`buildCartView`) — each line carries `line_id`, `name`, `menu_item_key`,
    `base_price_cents`, its modifiers, and the item's `available_modifiers` (each with
    `price_extra_cents`; numeric *ids* still omitted) so an edit by reference resolves from
    the cart alone. This is the prompt's `current_cart`. Prices are per unit and the view
    carries NO totals by design: it is built before the turn's operations apply, so any total
    here would be stale — the prompt's PRICE RULES forbid the agent summing or stating one.
  - **`history`** (Plan A): `finalize` appends each turn's `customer_text` + `agent_reply`
    (`mergeHistory`, capped at `LIMITS.maxHistoryTurns`). Re-sent to the next turn's agent as
    `conversation_history` so references ("that", answers to a prior reply) resolve.
    Reference-only — `current_cart` is the source of truth.

  Compiled with a `MemorySaver` checkpointer keyed by `thread_id =
  ${pos_config_id}:${cart_id}` — context follows the CART, not a session.
- **`OrderGraph` façade** exposes `start()` → `GraphTurnResult`: `complete` (`{output,
  base_version, reply?, language?}`) | `reply` (`{reply}`) | `junk` | `fail` (`{reason}`).
  `interpret()` is channel-driven: junk → junk; `failure_reason` → fail; `output` → complete
  (carrying `reply`/`language` when the propose_cart bundled one); `reply` → reply.
- **Reply is fire-and-forget** (no pause): the service emits `order.reply` and releases its
  FIFO slot; the customer's answer arrives as the **next** transcript, whose `classify`
  force-orders because the last history turn carries `agent_reply`. There is no consecutive-
  clarification cap anymore (clarify and suggest are one outcome; a legitimate multi-turn
  conversation shouldn't trip a cap, and within-turn runaway is bounded by `maxAgentSteps`).
- **Service** (`order-understanding-service.ts`) enqueues the turn, runs the graph once, then
  emits `order.operations_proposed` (with the `OrderProposal`), `order.reply`, or
  `voice.session_failed` (reason `agent_step_limit` / `agent_no_terminal` / `order_parse_failed`).
  A `complete` with a bundled reply emits BOTH — `order.operations_proposed` first (cart update
  before the confirmation), then `order.reply` (shared `speak` helper, defaulting the language to
  `TTS_LANGUAGE`). Both are fire-and-forget, so a confirmation can race a partial cart rejection
  (accepted for v1 — the cart module re-validates each op independently).
- **Contracts:** the cross-module wire shapes moved to `contracts/` — `cart-operation.schema`
  (the operation zod schema), `proposal`, `cart-view` (prompt-facing `CartView`/`CartLineView`/
  `HistoryTurn`), and `intent` (`intentSchema`/`DEFAULT_INTENT`). What stays in `schemas/` is
  ordering-internal: `order-graph-output` (**zod**, now operations-only — clarification is a
  reply, not an output) and `order-graph-input`. `graph/intents.ts` keeps only `INTENT_ROUTE`.
  The LLM speaks in `menu_item_key`/`modifier_key`; edits target a `line_id`.

## Dependencies
- `@langchain/langgraph` (graph + checkpointer), `zod` (schemas).
- `menu` (candidate search via the agent's `search_menu` tool + key resolution),
  `llm` (`chat` tool-calling + intent `complete`), `redis` (CartCache load), `events`
  (EventBus). `register-handlers.ts` binds to the bus.

## Key files
- `order-understanding-service.ts`, `order-graph.ts` (façade), `cart-turn-queue.ts`,
  `register-handlers.ts`.
- `graph/state.ts`, `graph/build-graph.ts` — LangGraph state + graph wiring (agent/tools nodes).
- `graph/intents.ts` — `INTENT_ROUTE` binary junk-gate (service → load_cart, junk → END). The
  `intentSchema` label set it routes on lives in `contracts/intent.ts`.
- `graph/instrument.ts` — `node(name, fn)` wrapper; logs `order.node_failed` on any node throw.
- `graph/parse-agent-reply.ts` — the agent's reply, parsed in ONE place for BOTH terminals.
  `parseAgentReply(obj) → AgentReply` holds the per-field degrade rules (blank/non-string reply →
  `null`; off-format ISO code → no language, never garbage forwarded to TTS; `mentioned_items`
  non-array → `[]`, and always `[]` when there is no usable reply) and is called by
  `tools/run-tools.ts` on the bundled `propose_cart` args. `parseSpokenReply(text)` adds only the
  text unwrapping the standalone terminal needs (fence, outermost `{…}` span, non-JSON spoken
  as-is) and delegates. A format slip never drops a reply nor reads JSON aloud.
- `mentioned-items.ts` — `toMentionedItem` (project a `CandidateItem` to the wire shape) and
  `resolveMentionedItems` (declared keys → verified items). Verification means "the agent actually
  retrieved it this turn": keys are checked against the turn's `search_results` and there is
  deliberately NO menu-lookup fallback — a key the agent never searched for is the hallucination the
  check exists to catch, not something to launder into a verified item. An unresolved key is dropped
  (never a tool error), so a `propose_cart` naming a
  bad key still commits. Deduped, first-mention order, capped at `LIMITS.maxMentionedItems`.
- `nodes/*.node.ts` — `classify-intent` (LLM junk-gate classifier, defaults to `service`),
  `normalize`, `load-cart`. (The old `retrieve`/`parse`/`suggest` nodes are gone.)
- `tools/required-modifiers.ts` — `findRequiredModifierViolations(ops, cartView, itemsByKey)`, pure.
  Validates the modifier set the batch RESULTS in, not each op in isolation: an `add_item`'s inline
  modifiers, and — for existing lines — the line's current modifiers with the batch's
  `add_modifier`/`remove_modifier` applied in order. That is what lets a legitimate SWAP
  (`remove_modifier` old + `add_modifier` new in one batch) net to exactly one and pass, while
  catching a bare remove that empties a required group or a bare add that leaves two. A line is
  judged **only on the groups the batch actually changed** (`touchedGroups`), not on every required
  group it has: a line can arrive non-compliant (created before this shipped, added via the
  degraded path, or with a ptav archived out of `available_modifiers`), and "add a side" must not
  turn into an interrogation about noodles. Everything else degrades OPEN and is skipped — a line
  the batch removes, an unresolved or UNAVAILABLE item (that is the cart's `unavailable_item`
  rejection to make, and asking first would waste a turn to reach the same refusal), an unknown
  `line_id`, an ungrouped option, and a missing `cart_view` (guard is truthy, not `!== null`).
  Identical messages are deduped.
- `tools/tool-specs.ts` — `search_menu` + `propose_cart` specs (`propose_cart` has optional
  `reply`/`language`/`mentioned_items`); `tools/run-tools.ts` — the `tools` node executing them
  (captures the bundled reply, accumulates `search_results`, resolves `mentioned_items` against the
  batch's own searches too); `tools/run-tools.test.ts` — the bundled-reply, accumulation, and
  resolution cases.
- `schemas/*.ts` — ordering-internal only: `order-graph-output` (operations-only, zod) +
  `order-graph-input`. The shared shapes (`cart-operation.schema`, `proposal`, `cart-view`,
  `intent`) now live in `contracts/`; `zod-error` moved to `shared/`.
- `order-understanding-service.test.ts` — happy path, edits, spoken-reply fire-and-forget
  (reply then answered next transcript), force-service after a reply, propose validation retry,
  step-limit fail, per-cart FIFO, history persistence, junk short-circuit, reply language
  (agent-declared wins; `en` default ignores STT; a declaration never leaks into a later turn),
  and the bundled propose+reply cases (both events fire; language defaults; beef-jerky
  propose-is-last-call regression).
- `graph/parse-agent-reply.test.ts` — the reply terminal's degradation matrix.

## Not done yet
- Business validation of operations against candidates (unknown key → clarify) is deferred to
  the Cart Validator. `supported_languages` is still hardcoded `[]` (TODO: source from
  `voice_restaurant_settings`). `MemorySaver` is in-process only — a durable checkpointer would
  survive restarts. Production requires a **tool-capable** model (the stub scripts tool calls;
  a non-tool-calling runtime model cannot drive the agent). A prompted-ReAct fallback for weak
  models is deferred (docs/agent-tools.md §4).
