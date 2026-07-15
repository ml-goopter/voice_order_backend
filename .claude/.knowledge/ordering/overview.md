---
type: Concept
title: Order Understanding (LangGraph-style)
description: Serialized per-cart turns → agent tool-calling loop → operations_proposed / reply.
resource: src/ordering
timestamp: 2026-07-13
---

# Order Understanding

## Purpose
Turns `stt.final_transcript.received` into an `OrderProposal` (operations +
`base_version`) or an `order.reply` (a spoken clarification/recommendation), design §6.
It is a **pure proposer**; the Cart Module validates and applies.

## Mechanics
- **Tier-1 per-cart FIFO** (`cart-turn-queue.ts`, backed by `shared/async-lock`):
  final transcripts for one `cart_id` run one turn at a time in arrival order, so
  turn 2 sees turn 1's result and loads a fresh `base_version` (design §9). Sits
  **in front of** the graph.
- **Graph** (`order-graph.ts` + `graph/`) is a real `@langchain/langgraph`
  `StateGraph` implementing an **agent tool-calling loop** (docs/agent-tools.md), NOT a
  fixed retrieve→parse pipeline: `normalize → classify → load_cart → agent ⇄ tools →
  finalize → END`.
  - **classify** is a **junk-gate** only. It labels the utterance `order`/`suggest`/`junk`
    via a cheap first-hop LLM call on its OWN provider/creds (`INTENT_LLM_*` env, falling
    back to `LLM_*`; `createIntentLlmProvider` → `GraphDeps.intentLlm` →
    `nodes/classify-intent.node.ts`), routing via the one table-driven conditional edge
    `INTENT_ROUTE` (`graph/intents.ts`, single source of truth). `order` AND `suggest`
    both route into the pipeline (`load_cart` → `agent`) — the agent decides the outcome;
    `junk` → straight to `END` (a non-orderable utterance is NOT recorded to history, so it
    can't pollute later context). The classifier DEGRADES to `order` on any failure (so a
    real order is never dropped; the `stub` provider therefore always yields `order`). When
    the previous turn ended in a spoken reply (the last `history` entry has `agent_reply`),
    classify **forces `order`** and skips the LLM call, so a terse follow-up isn't misrouted
    to junk.
  - **agent** (`nodes` inline in `build-graph.ts`) runs one LLM tool-calling turn via
    `LlmProvider.chat`. On first entry it seeds the transcript with the system prompt +
    user context (`buildAgentMessages` in `llm/agent-prompt-builder.ts`: `customer_text`,
    `current_cart`, `conversation_history` — candidates are NOT pre-fetched). It ends the
    turn one of two ways: by calling **`propose_cart`** (structured operations), or by
    **replying** (no tool call) — a single "reply" outcome serving as both a clarifying question
    and a recommendation. A reply is strict JSON `{reply, language}` parsed by
    `graph/parse-spoken-reply.ts`, which writes the agent-declared language onto the turn-scoped
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
    the old separate schema-repair round). A successful `propose_cart` writes the `output`
    channel and ends the loop.
  - **finalize** records the completed turn to `history`: always `customer_text`, plus
    `agent_reply` when the agent ended by speaking (so the next turn has the context and
    force-orders). Committed/failed turns record only the utterance.
- **State** (`graph/state.ts`, `Annotation.Root`, last-write-wins with defaults):
  `base_version` captured at `load_cart` (= `cart.version`). The agent's two mutually
  exclusive terminal channels are `output` (propose_cart) and `reply` (spoken). Turn-scoped
  channels reset by `normalize` each turn (the checkpointer persists everything, so anything
  left would leak): `output`, `reply`, `agent_messages` (the tool-calling scratchpad — NEVER
  persisted across turns), `agent_steps`, `failure_reason`. Two channels carry across turns:
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
  base_version}`) | `reply` (`{reply}`) | `junk` | `fail` (`{reason}`). `interpret()` is
  channel-driven: junk → junk; `failure_reason` → fail; `output` → complete; `reply` → reply.
- **Reply is fire-and-forget** (no pause): the service emits `order.reply` and releases its
  FIFO slot; the customer's answer arrives as the **next** transcript, whose `classify`
  force-orders because the last history turn carries `agent_reply`. There is no consecutive-
  clarification cap anymore (clarify and suggest are one outcome; a legitimate multi-turn
  conversation shouldn't trip a cap, and within-turn runaway is bounded by `maxAgentSteps`).
- **Service** (`order-understanding-service.ts`) enqueues the turn, runs the graph once, then
  emits `order.operations_proposed` (with the `OrderProposal`), `order.reply`, or
  `voice.session_failed` (reason `agent_step_limit` / `agent_no_terminal` / `order_parse_failed`).
- **Contracts** in `schemas/`: `cart-operation` + `order-graph-output` are **zod** schemas
  (`order-graph-output` is now operations-only — clarification is a reply, not an output);
  `order-graph-input` holds prompt-facing `CartView`/`CartLineView`/`HistoryTurn` types; the
  LLM speaks in `menu_item_key`/`modifier_key`; edits target a `line_id`.

## Dependencies
- `@langchain/langgraph` (graph + checkpointer), `zod` (schemas).
- `menu` (candidate search via the agent's `search_menu` tool + key resolution),
  `llm` (`chat` tool-calling + intent `complete`), `redis` (CartCache load), `events`
  (EventBus). `register-handlers.ts` binds to the bus.

## Key files
- `order-understanding-service.ts`, `order-graph.ts` (façade), `cart-turn-queue.ts`,
  `register-handlers.ts`.
- `graph/state.ts`, `graph/build-graph.ts` — LangGraph state + graph wiring (agent/tools nodes).
- `graph/intents.ts` — `intentSchema` (`order`/`suggest`/`junk`) + `INTENT_ROUTE` junk-gate
  (order/suggest → load_cart, junk → END).
- `graph/instrument.ts` — `node(name, fn)` wrapper; logs `order.node_failed` on any node throw.
- `graph/parse-spoken-reply.ts` — pure parser for the agent's spoken terminal (the outermost `{…}`
  span → `SpokenReply`), degrading per-field so a format slip never drops a reply nor reads JSON
  aloud.
- `nodes/*.node.ts` — `classify-intent` (LLM intent classifier, defaults to `order`),
  `normalize`, `load-cart`. (The old `retrieve`/`parse`/`suggest` nodes are gone.)
- `tools/tool-specs.ts` — `search_menu` + `propose_cart` specs; `tools/run-tools.ts` —
  the `tools` node executing them.
- `schemas/*.ts` — `cart-operation` (zod), `order-graph-output` (operations-only, zod),
  `order-graph-input` (CartView/HistoryTurn types), `clarification`/`proposal`, `zod-error`.
- `order-understanding-service.test.ts` — happy path, edits, spoken-reply fire-and-forget
  (reply then answered next transcript), force-order after a reply, propose validation retry,
  step-limit fail, per-cart FIFO, history persistence, junk short-circuit, reply language
  (agent-declared wins; `en` default ignores STT; a declaration never leaks into a later turn).
- `graph/parse-spoken-reply.test.ts` — the reply terminal's degradation matrix.

## Not done yet
- Business validation of operations against candidates (unknown key → clarify) is deferred to
  the Cart Validator. `supported_languages` is still hardcoded `[]` (TODO: source from
  `voice_restaurant_settings`). `MemorySaver` is in-process only — a durable checkpointer would
  survive restarts. Production requires a **tool-capable** model (the stub scripts tool calls;
  a non-tool-calling runtime model cannot drive the agent). A prompted-ReAct fallback for weak
  models is deferred (docs/agent-tools.md §4).
