---
type: Concept
title: Platform (foundations + composition root)
description: config, shared utils, auth, observability, and app/server wiring.
resource: src/config, src/shared, src/auth, src/observability, src/api, src/app.ts, src/server.ts
timestamp: 2026-07-07
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
- **auth** — `authenticate()` resolves `{ session_id, cart_id, pos_config_id }`
  (stub; TODO signed token + table→POS lookup).
- **observability** — `metrics.ts` no-op sink (TODO real registry).
- **api** — `health.routes.ts` (`healthCheck()` payload).
- **composition root** — `app.ts` `createApp()` constructs infra (cart cache, db,
  menu, stt, llm), Voice+Realtime, Order Understanding, and the Cart Module, calls
  each `register-handlers`, and exposes `start`/`stop`. `server.ts` is the entrypoint
  (boot + SIGINT/SIGTERM). Build: `nodenext` ESM, `type: module`, `types: [node]`.

## Dependencies
- Used by all modules. `app.ts` imports every module's public surface.

## Key files
- `config/{env,logger,constants}.ts`, `shared/{types,result,errors,ids,time,async-lock}.ts`,
  `auth/{auth-types,session-auth}.ts`, `observability/metrics.ts`,
  `api/health.routes.ts`, `app.ts`, `server.ts`.

## Notes
- `KeyedAsyncLock` and the whole design are single-process; §9 scale-out shards by
  `cart_id`. Auth, metrics, logger, and the health HTTP surface are minimal stubs.
