---
type: Concept
title: Event Bus
description: Typed EventEmitter wrapper + the AppEventMap contract.
resource: src/events
timestamp: 2026-07-15
---

# Event Bus

## Purpose
The backbone of the modular monolith (design §2): a typed publish/subscribe bus so
modules stay decoupled behind event contracts rather than direct references.

## Mechanics
- `event-types.ts` defines `AppEventMap` — event name → payload — covering the core
  events: `client.connected`, `stt.final_transcript.received`, `order.operations_proposed`,
  `order.clarification_needed`, `order.clarification_answered`, `cart.updated`,
  `cart.operation_rejected`, `voice.session_failed`, `voice.session_ended`.
- **`client.connected`** (`{cart_id, pos_config_id, session_id, device_id, table_id?}`) is
  emitted by the realtime gateway at `onConnect` and handled by the cart module, which
  creates the cart with its durable identity stamped. It exists so identity does **not**
  thread through the ordering module: the tempting path (transcript → graph input →
  `OrderProposal` → `applyProposal`) would push `device_id`/`table_id` through the LLM
  graph, which never reads them. One new contract instead of five changed ones.
- `event-bus.ts` wraps Node's `EventEmitter` with generic `emit`/`on`/`off` keyed
  by `AppEventName`, so payloads are compile-checked. A singleton `eventBus` is the
  shared instance; each module's `register-handlers.ts` subscribes to it.
- **Correlation trace** — the bus sees every event, so `emit` writes one DEBUG
  `event.emit` line pulling `request_id`/`cart_id`/`session_id` off the top level of
  the payload (each included only when present). It's the single cross-cutting log
  that lets a developer follow one turn end-to-end, so payloads deliberately carry
  those ids at the top level even when they're also nested: `order.operations_proposed`
  and `cart.updated` hoist `request_id` (and `cart_id`) up from inside `proposal`/`cart`
  so the `request_id` thread survives the propose→apply→update hops. Requires
  `LOG_LEVEL=debug`.

## Dependencies
- `cart/cart-types`, `contracts/{cart-operation.schema, proposal}`, `shared/types` for payload
  shapes — no longer reaches into `ordering` (the shared shapes moved to `contracts/`).
- `config/logger` for emit tracing.

## Key files
- `event-types.ts` — event payloads + `AppEventMap`.
- `event-bus.ts` — `EventBus` class + `eventBus` singleton.

## Notes
- In-process only. Design §9 scale-out: shard by `cart_id` (keeps the per-cart FIFO
  and apply lock in-memory) before reaching for Redis Streams / Kafka.
