---
type: Concept
title: Event Bus
description: Typed EventEmitter wrapper + the AppEventMap contract.
resource: src/events
timestamp: 2026-07-07
---

# Event Bus

## Purpose
The backbone of the modular monolith (design §2): a typed publish/subscribe bus so
modules stay decoupled behind event contracts rather than direct references.

## Mechanics
- `event-types.ts` defines `AppEventMap` — event name → payload — covering the core
  events: `stt.final_transcript.received`, `order.operations_proposed`,
  `order.clarification_needed`, `order.clarification_answered`, `cart.updated`,
  `cart.operation_rejected`, `voice.session_failed`, `voice.session_ended`.
- `event-bus.ts` wraps Node's `EventEmitter` with generic `emit`/`on`/`off` keyed
  by `AppEventName`, so payloads are compile-checked. A singleton `eventBus` is the
  shared instance; each module's `register-handlers.ts` subscribes to it.

## Dependencies
- `cart/cart-types`, `ordering/schemas/*`, `shared/types` for payload shapes.
- `config/logger` for emit tracing.

## Key files
- `event-types.ts` — event payloads + `AppEventMap`.
- `event-bus.ts` — `EventBus` class + `eventBus` singleton.

## Notes
- In-process only. Design §9 scale-out: shard by `cart_id` (keeps the per-cart FIFO
  and apply lock in-memory) before reaching for Redis Streams / Kafka.
