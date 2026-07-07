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
- **Graph** (`order-graph.ts`) is a hand-rolled node pipeline standing in for
  LangGraph JS: `normalize-transcript → load-cart → retrieve-candidates →
  parse-order (LLM) → validate-operations`. Returns `{ output, base_version }`
  where `base_version = cart.version` at load time.
- **Service** (`order-understanding-service.ts`) enqueues the turn, then emits
  `order.operations_proposed` (with the `OrderProposal`) or
  `order.clarification_needed`, or `voice.session_failed` on parse failure.
- **Contracts** in `schemas/`: `cart-operation` (LLM output ops, hand-written
  validators — TODO zod), `order-graph-input/output`, `clarification`, `proposal`.
  The LLM speaks in `menu_item_key`/`modifier_key`; edits target a `line_id`.

## Dependencies
- `menu` (candidates + key resolution), `llm` (parse), `persistence` (CartCache
  load), `events` (EventBus). `register-handlers.ts` binds to the bus.

## Key files
- `order-understanding-service.ts`, `order-graph.ts`, `cart-turn-queue.ts`,
  `register-handlers.ts`.
- `nodes/*.node.ts` — the five pipeline steps.
- `schemas/*.ts` — operation/input/output/clarification/proposal types + validators.

## Not done yet
- Real LangGraph with a cart-keyed checkpointer (thread = `${pos_config_id}:${cart_id}`)
  for pause/resume; `handleClarificationAnswer` is a stub. Business validation of
  operations against candidates (unknown key → clarify, §11.3) is deferred to the
  Cart Validator.
