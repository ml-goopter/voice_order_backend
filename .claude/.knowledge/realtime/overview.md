---
type: Concept
title: Realtime Gateway
description: Owns the WebSocket lifecycle; routes inbound messages and pushes backend events.
resource: src/realtime
timestamp: 2026-07-07
---

# Realtime Gateway

## Purpose
The client-facing edge (design §4). One WebSocket per app carries both voice and
cart traffic. Accepts/authenticates connections, routes inbound `voice.*` / `order.*`
messages to owning modules, tracks clients by `session_id` / `cart_id`, and pushes
backend events (cart updates, clarification questions, rejections, errors) back out.
It owns **no cart logic** — it only delivers what the Cart Module produces.

## Mechanics
- **Inbound:** `parseInbound` decodes JSON into a discriminated `InboundMessage`
  union; `MessageRouter.route` dispatches to the Voice handler, or emits
  `order.clarification_answered` on the bus. `connection.resume` is handled in the
  gateway (needs the cart cache) and replies with a `connection.resumed` snapshot
  (design §3).
- **Outbound (bus → sockets):** the gateway subscribes to `cart.updated` (broadcast
  to **every** socket on the `cart_id` — multi-device/reconnect, §9 Tier 2),
  `order.clarification_needed` (to the asking session), and `cart.operation_rejected`
  (to the originating session, else the whole cart).
- **Partial transcripts** are sent to the client directly by the Voice module, not
  here — they never enter the backend event flow (§3).
- **Client registry** indexes connections `bySession` and `byCart`.

## Dependencies
- `events` (EventBus) — subscribe/emit.
- `voice` (VoiceMessageHandler) — inbound voice routing + disconnect.
- `persistence` (CartCache) — resume snapshot.
- `cart/cart-types` — `Cart` shape in outbound messages.

## Key files
- `realtime-gateway.ts` — subscriptions, connect/disconnect, resume.
- `message-router.ts` — inbound dispatch.
- `client-registry.ts` — `ClientConnection` interface + session/cart indexes
  (carries `pos_config_id` resolved at auth).
- `realtime-message-types.ts` — inbound/outbound unions + `parseInbound`.
- `websocket-server.ts` — **stub**; TODO wire `ws` (adapt sockets to
  `ClientConnection`, heartbeat per `TIMEOUTS`).
