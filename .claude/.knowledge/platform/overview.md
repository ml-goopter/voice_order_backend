---
type: Concept
title: Platform (foundations + composition root)
description: config, shared utils, auth, observability, and app/server wiring.
resource: src/config, src/shared, src/auth, src/observability, src/api, src/app.ts, src/server.ts
timestamp: 2026-07-15
---

# Platform

## Purpose
The cross-cutting layer every module builds on, plus the composition root that
constructs modules and wires them to the event bus.

## Mechanics
- **config** — `env.ts` (typed `config` from `process.env` with defaults),
  `logger.ts` (console-backed structured `Logger`; TODO pino), `constants.ts`
  (`TIMEOUTS`, `LIMITS` drawn from the design).
- **shared** — `types.ts` (our text ids vs Odoo integer ids, `Cents`, `LangCode`),
  `result.ts` (`Result`/`ok`/`err`), `errors.ts` (`AppError`, `ValidationError`,
  `CartRejectedError` with a `reason`), `ids.ts` (`newCartId`/`newSessionId`/
  `newRequestId`/`newLineId`), `time.ts`, `async-lock.ts` (`KeyedAsyncLock` — the
  per-cart serialization primitive behind the Tier-1 FIFO and Tier-2 apply lock).
- **auth** — `authenticate()` resolves
  `{ session_id, cart_id, pos_config_id, device_id, table_id? }` (stub; TODO signed token +
  table→POS lookup). `device_id` is required, `table_id` optional (absent = takeout).
- **observability** — `metrics.ts` no-op sink (TODO real registry).
- **api** — the app's whole REST surface, hand-rolled on the existing `node:http` server
  (two routes do not justify a framework in a WebSocket-first app; everything else rides
  `/ws`). `health.routes.ts` is the `healthCheck()` payload; `http-router.ts` is
  `createHttpRouter(cartController)` → a `RequestListener` injected into
  `startWebSocketServer`:
  | Route | Answers |
  |---|---|
  | `GET /health`, `GET /healthz` | 200 + `healthCheck()` |
  | `POST /v1/carts/:cart_id/confirm` | 200 **empty** (no body in or out); 404 unknown cart; 502 + Odoo's message; 500 otherwise |

  Confirm takes **no request body** — the cart already knows its table. A re-confirm is
  200, not an error (idempotent). `pos_order_id` is persisted on the cart but deliberately
  **not** returned: the frontend clears its cart view on the 200. Honest status codes here
  are *deliberately unlike* the JSON-RPC far side, which answers 200 even on failure — do
  not propagate their convention outward. **Nothing authenticates this route**, matching
  the `session-auth` stub posture (`cart_id` on the `/ws` upgrade is equally
  unauthenticated); it is not a security boundary and should become one only when `/ws`
  does.
- **composition root** — `app.ts` `createApp()` constructs infra (cart cache, db,
  menu, stt, llm, the Odoo client), Voice+Realtime, Order Understanding, and the Cart
  Module, calls each `register-handlers`, and passes `createHttpRouter(cartController)`
  into `startWebSocketServer`. `server.ts` is the entrypoint (boot + SIGINT/SIGTERM).
  Build: `nodenext` ESM, `type: module`, `types: [node]`.

## Dependencies
- Used by all modules. `app.ts` imports every module's public surface.

## Key files
- `config/{env,logger,constants}.ts`, `shared/{types,result,errors,ids,time,async-lock}.ts`,
  `auth/{auth-types,session-auth}.ts`, `observability/metrics.ts`,
  `api/{health.routes,http-router}.ts`, `app.ts`, `server.ts`.

## Notes
- `KeyedAsyncLock` and the whole design are single-process; §9 scale-out shards by
  `cart_id`. Auth, metrics, and the logger are minimal stubs.
- `shared/types.ts` splits **our** identities (text: `cart_id`, `session_id`, `request_id`,
  `line_id`, `device_id`) from **Odoo's** (integer: `pos_config_id`, `product_tmpl_id`,
  `ptav_id`, `restaurant_table_id`, `pos_order_id`). `device_id` is ours and survives
  reconnects, which `session_id` does not.
