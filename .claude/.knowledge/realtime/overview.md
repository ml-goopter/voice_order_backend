---
type: Concept
title: Realtime Gateway
description: Owns the WebSocket lifecycle; routes inbound messages and pushes backend events.
resource: src/realtime
timestamp: 2026-07-15
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
- **`client.connected`:** `onConnect` emits it with the socket's
  `{cart_id, pos_config_id, session_id, device_id, table_id?}` so the cart module can
  create the cart with its durable identity **before** any ordering happens. This is the
  only place identity enters the backend; it deliberately never threads through the
  ordering module. The gateway itself stays cart-logic-free — it emits and forgets.
- **Spoken replies (`order.reply`):** the gateway sends the reply **text** to the session
  socket **and** drives `TtsService.speak` to synthesize it and stream `tts.*` audio frames
  back over the same socket (base64 in JSON). See the [tts](../tts/index.md) bundle.
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
- `client-registry.ts` — `ClientConnection` interface + session/cart indexes (carries
  `pos_config_id`, `device_id` and optional `table_id`, all resolved at auth). `byCart` is
  a **Set** because sockets on one cart overlap transiently: on reconnect the new socket is
  added before the old one's close fires (up to `heartbeatTimeoutMs`/`reconnectWindowMs`).
  Removing by identity — rather than clearing the cart key — is what keeps the live socket
  reachable; collapsing it to one connection would let a late close silently kill
  `cart.updated` delivery to the live socket.
- `realtime-message-types.ts` — inbound/outbound unions + `parseInbound`.
- `websocket-server.ts` — the `ws` transport. A `WebSocketServer` on path `/ws` is
  attached to an `http.Server` whose request handler is **injected** (the REST router,
  `api/http-router.ts`), so transport and routing stay separate. Each socket: auth via URL
  query params (`authenticate`, `auth/session-auth.ts`) — failure closes with code `4001`;
  a `ClientConnection` adapts `send`/`close`/`isAlive` over the socket;
  `onConnect`/`onRawMessage`/`onDisconnect` wire to the gateway. Heartbeat is one
  interval (`TIMEOUTS.heartbeatIntervalMs`): miss one ping → `terminate()`. The
  handle exposes the `http.Server` and a `close()` (clears the interval, drops
  sockets, closes both servers).
- **Auth params** (`paramsFromUrl`): `session_id`, `cart_id`, `pos_config_id` and
  `device_id` are **required** (any missing → `4001`); `table_id` is optional — absent
  means takeout/untabled, a valid order. Auth is still the query-param **stub**: signed
  tokens remain a TODO, and `device_id`/`table_id` are as unauthenticated as `cart_id`.
  They identify a cart; they do not authorize access to it.
