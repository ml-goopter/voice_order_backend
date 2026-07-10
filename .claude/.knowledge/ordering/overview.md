---
type: Concept
title: Order Understanding (LangGraph-style)
description: Serialized per-cart turns → node pipeline → operations_proposed or clarification_needed.
resource: src/ordering
timestamp: 2026-07-07
---

# Order Understanding

## Purpose
Turns `stt.final_transcript.received` into an `OrderProposal` (operations +
`base_version`) or an `order.clarification_needed` (design §6). It is a **pure
proposer**; the Cart Module validates and applies.

## Mechanics
- **Tier-1 per-cart FIFO** (`cart-turn-queue.ts`, backed by `shared/async-lock`):
  final transcripts for one `cart_id` run one turn at a time in arrival order, so
  turn 2 sees turn 1's result and loads a fresh `base_version` (design §9). Sits
  **in front of** the graph.
- **Graph** (`order-graph.ts` + `graph/`) is a real `@langchain/langgraph`
  `StateGraph`, a straight line: `normalize → load_cart → retrieve → parse → finalize
  → END`. A clarification is NOT a branch/pause — `parse` simply sets
  `needs_clarification` and `finalize` records the question; the graph always runs to
  `END`. Compiled with a `MemorySaver` checkpointer keyed by
  `thread_id = ${pos_config_id}:${cart_id}` — context follows the CART, not a
  session, so multiple sessions on one cart share conversational memory (§6). State
  channels live in `graph/state.ts` (`Annotation.Root`, last-write-wins with
  defaults); `base_version` is captured at `load_cart` (= `cart.version`). Two channels carry information across turns beyond a single
  invoke (Plan A); `candidates` is per-turn (last-write-wins — `retrieve` fully
  replaces it each turn, capped at `LIMITS.maxCandidatesToLlm`):
  - **`cart_view`** (Plan A): `load_cart` projects the stored cart into a
    self-describing `CartView` (`buildCartView`) — each line carries `line_id`, `name`,
    `menu_item_key`, its current modifiers, and the item's `available_modifiers`
    (keys/names only; numeric ids omitted) so an edit by reference resolves from the
    cart alone. This is the prompt's `current_cart`; the stored `Cart` shape is untouched.
    It supersedes the earlier candidate-accumulation idea (Plan B, removed): a
    cart-resident item's `line_id` + modifier vocabulary now come from the cart itself,
    not from keeping stale candidates alive.
  - **`history`** (Plan A): the `finalize` node appends each completed turn's
    `customer_text`, plus — when THIS turn raised a clarification — the newly asked
    `clarification_question` (`mergeHistory`, capped at `LIMITS.maxHistoryTurns`). Re-sent
    to the next turn's `parse` as `conversation_history` so references ("that", "the same")
    resolve. Reference-only — the prompt forbids re-executing a past request; `current_cart`
    is the source of truth.

  The `OrderGraph` façade exposes `start()` returning a `GraphTurnResult`
  (`complete` with `{output, base_version}` | `clarify` with `{question, round, options?}`).
- **Clarification is fire-and-forget** (§6, no pause): when `parse` sets
  `needs_clarification`, `finalize` records the question to `history` and the turn ENDS —
  the service emits `order.clarification_needed` and releases its FIFO slot (nothing
  blocks, no timeout). The customer's answer arrives as the **next** `stt.final_transcript`;
  that turn's `normalize` sees the pending question as the last `history` entry
  `clarification_question` and carries it into `parse`
  (the current utterance is the answer) so it resolves the original request. `trailingClarificationRun(history)`
  counts consecutive unanswered clarifications; the service fails the turn
  (`voice.session_failed` reason `clarification_unresolved`) once it exceeds
  `MAX_CLARIFICATION_ROUNDS`, so a looping model can't freeze the cart. There is no
  `order.clarification_answered` inbound message anymore — the answer is just the next turn.
- **Schema-repair retry** (§11.3 stages 2/3): `nodes/parse-and-validate.node.ts`
  validates the LLM JSON and, on failure, re-prompts once (`LIMITS.llmMaxRetries`)
  with `buildRepairPrompt` (rejected output + validation error). Exhaustion throws →
  the `parse` node rejects → service emits `voice.session_failed` (`order_parse_failed`).
- **Service** (`order-understanding-service.ts`) enqueues the turn, runs the graph once,
  then emits `order.operations_proposed` (with the `OrderProposal`) or
  `order.clarification_needed`, or `voice.session_failed`.
- **Contracts** in `schemas/`: `cart-operation` + `order-graph-output` are **zod**
  schemas (types inferred; `parse*` return `Result` with a repair-friendly message
  via `zod-error.ts`); `order-graph-input`, `clarification`, `proposal` are types.
  The LLM speaks in `menu_item_key`/`modifier_key`; edits target a `line_id`.

## Dependencies
- `@langchain/langgraph` (graph + checkpointer), `zod` (schemas).
- `menu` (candidates + key resolution), `llm` (parse), `persistence` (CartCache
  load), `events` (EventBus). `register-handlers.ts` binds to the bus.

## Key files
- `order-understanding-service.ts`, `order-graph.ts` (façade), `cart-turn-queue.ts`,
  `register-handlers.ts`.
- `graph/state.ts`, `graph/build-graph.ts` — LangGraph state + graph wiring.
- `graph/instrument.ts` — `node(name, fn)` wrapper; logs `order.node_failed` (with node name +
  correlation ids) on any node throw, passing through LangGraph control-flow bubbles.
- `nodes/*.node.ts` — `normalize`, `load-cart`, `retrieve-candidates`, `parse-order`,
  `validate-operations`, and `parse-and-validate` (parse + repair loop).
- `schemas/*.ts` — operation/input/output/clarification/proposal types + zod validators.
- `order-understanding-service.test.ts` — happy path, edits, fire-and-forget clarify
  (question then answered by the next transcript), consecutive-clarification cap, repair
  (retry + exhaustion), per-cart FIFO ordering.

## Not done yet
- Business validation of operations against candidates (unknown key → clarify,
  §11.3 stage 4) is deferred to the Cart Validator. `supported_languages` is still
  hardcoded `[]` (TODO: source from `voice_restaurant_settings`). `MemorySaver` is
  in-process only — a durable (Redis/Postgres) checkpointer would survive restarts.
