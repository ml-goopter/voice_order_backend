# Refactor Plan — Cleanup + Coverage

_Created 2026-07-16. Goal: reduce complexity / clean up + improve test coverage across the whole `src/` codebase. Basis: 4 parallel read-only surveys (complexity/duplication, dead code, coverage gaps, module boundaries)._

**Guiding rules** (per CLAUDE.md): surgical changes, DRY, simplicity over complexity, test-first. Each phase is independently shippable; run full vitest + typecheck before starting and after each phase.

The codebase is already well-factored (short files, clean event chain, real test doubles). This is cleanup + coverage, not a rescue.

---

## Phase 0 — Baseline
- Run `npm test` + typecheck; record green baseline.
- Refresh stale `docs/unit-test-coverage-audit.md` (2026-07-09) to match current files: ordering module rewritten to agent⇄tools loop (`run-tools.ts`/`tool-specs.ts` added; `parse-and-validate`/`parse-order`/`retrieve-candidates`/`validate-operations` nodes deleted); `prompt-builder.ts` → `agent-prompt-builder.ts` + `intent-prompt-builder.ts`; `menu-index.ts` deleted; `menu-store.ts` now interface-only.

## Phase 1 — Zero-risk dead-code deletion
Delete (each grep-confirmed unused across src + tests):
- `isOk` — `shared/result.ts:9`
- `newCartId`, `newSessionId` — `shared/ids.ts:4-5` (IDs come from WS query params)
- `nowMs` — `shared/time.ts:2`
- `OperationAction` type — `ordering/schemas/cart-operation.schema.ts:61`
- `src/observability/metrics.ts` — zero call sites, abandoned scaffolding
- `src/ordering/schemas/clarification.schema.ts` — superseded by `OrderReply`

_Verify: typecheck + suite green._

## Phase 2 — Latent bug: dead `voice.session_*` events → ADD SUBSCRIBER
`voice.session_failed` / `voice.session_ended` emitted 7× (incl. `order-understanding-service.ts:116` on turn failure) but have **no subscriber** — a failed ordering turn is silently dropped, never reaching the client.
- Decision (user, 2026-07-16): **this is a bug.** Add a realtime-gateway subscriber that pushes a client frame (`voice.error` / session-status) on `voice.session_failed`; decide session-ended handling.
- _Verify: test that a failed turn results in an outbound client frame._

## Phase 3 — DRY / simplicity cleanups (behavior-preserving)
- **`displayName` helper**: `names.en_US ?? Object.values(names)[0] ?? fallback` is copy-pasted in 5 places (`postgres-menu-store.ts:22`, `candidate-matcher.ts:139`, `cart-operation-applier.ts:60,66`, `load-cart.node.ts:47` — last has a drifted 5-level variant). Extract one helper, reuse.
- **`messageOf` reuse**: replace 4 inline `err instanceof Error ? err.message : String(err)` (`tts-service.ts:50,85,88`, `websocket-server.ts:78`) with existing `shared/errors.ts` `messageOf`.
- **Provider-factory switch**: llm/stt/tts/embedding factories each `switch` a config string with one real case → collapse to `if (key) … else Noop`.
- **`voice-message-handler` timers**: add `isTerminal(session)` + `clearTimer()` helpers (guard repeated :53/:144; `clearTimeout;=null` at 6 sites). No protocol change.

_Verify: suite green after each; behavior preserved._

## Phase 4 — Test-coverage backfill (highest-value first)
1. `ordering/tools/run-tools.ts` — empty-ops `propose_cart` must be a retriable tool error, not silent accepted-empty proposal; unknown-tool default; `safeParse` failure.
2. `llm/agent-prompt-builder.ts` — `scrubSchema` strips `$schema`/`MAX_SAFE_INTEGER`; advertised ops derived from `cartOperationSchema` (no drift); full `available_modifiers` un-trimmed invariant. (Coverage lost on rename.)
3. `ordering/graph/instrument.ts` — bubble-up (interrupt/Command) re-thrown WITHOUT logging; real throw logs `order.node_failed` once.
4. `auth/session-auth.ts` — `pos_config_id: 0` accepted (`=== undefined`, not truthiness); each missing field → `unauthenticated`; `table_id` omission.
5. `config/env.ts` — non-numeric → fallback (not `NaN`); empty-string → unset; `INTENT_LLM_*` → `LLM_*` chain.
6. `menu/candidate-matcher.ts` — lexical-union recall (KNN-miss + lexical-hit still surfaced); headline feature, currently 0 assertions.
7. `config/logger.ts` (threshold gate, unknown level → info, `child()` merge), `tts/tts-client.ts` (linear16 vs mp3, no-key Noop), `stt/stt-client.ts` (no-key Noop trap), `voice/voice-session-manager.ts` (stream close-before-delete on remove).

Lower value (optional): `ordering/register-handlers.ts` + `cart/register-handlers.ts` `.catch` guards, `ordering/schemas/zod-error.ts`, `shared/errors.ts`, `menu/in-memory-menu-store.ts` (the reference double every matcher test trusts), `ordering/order-graph.ts` status precedence.

_Verify: each new test fails against a deliberately-broken source, then passes._

## Phase 5 — Architecture: extract cross-module contracts
Single highest-leverage structural move — removes 3 coupling problems at once:
- Create `src/contracts/` (or `shared/contracts/`) holding the cross-module wire DTOs currently buried in `ordering/schemas/`: `cart-operation.schema`, `proposal`, and the `CartView`/`HistoryTurn` shapes used by prompts. Keep ordering-only schemas (`order-graph-*`, `zod-error`) in `ordering`.
- Fixes: reversed `llm → ordering` dependency (`agent-prompt-builder.ts:3-4`, `intent-prompt-builder.ts:2`); `cart ↔ odoo` circular import (`cart-repository.ts:6-7` ↔ `cart-to-insert-request.ts:1`); `events → business-module` coupling (`event-types.ts:14-16`).
- Then move `agent-prompt-builder.ts` + `intent-prompt-builder.ts` out of `llm/` into `ordering/prompts/` (they are ordering-specific, not generic LLM infra); `llm/` stays a pure provider abstraction.

_Verify: no cross-business-module deep imports remain (grep); suite green; typecheck clean._

### Deferred (not in this pass — larger, lower ROI)
- realtime/voice/tts `ClientConnection` port extraction (mutual entanglement, partly by-design).
- cart read-port (`cart.getSnapshot`) so ordering/realtime stop reading raw `CartCache`.
- Standardize bus wiring to `registerXHandlers(bus,…)` for realtime (currently subscribes in constructor).
- Map `OdooError` to a neutral gateway error at the cart boundary (`api/http-router.ts:66`).
- Rename `cart-controller.ts` → `cart-service.ts`; unify file-suffix conventions.
- Unfinished-feature TODOs (keep): auth token verification, HTTP-route auth, tax (`cart-operation-applier.ts:22,39`), source `supported_languages` from settings.
