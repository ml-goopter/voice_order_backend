# Implementation Checklist — Voice-Based Ordering

**State:** The codebase is a **typed scaffold**. Contracts, wiring, event bus, and
concurrency machinery (per-cart FIFO, apply lock, version/rebase, idempotency) are
real. Every external system sits behind an interface with a **stub**. `tsc` is
green and the app boots, but no runtime deps are installed (`dependencies: (none)`)
and there are **no tests** (the `test` script points at vitest, which isn't
installed).

"What needs to be done" = replace stubs with real implementations, module by module.
References are to `design.cleaned.md` sections.

---

## 0. Foundation (unblocks everything)
- [ ] **Install runtime deps** — nothing works end-to-end until these land: `ws`,
  `ioredis`, `pg`, the STT SDK(s), the LLM SDK(s), an embeddings client,
  `@langchain/langgraph`, and `zod` (see §5). Currently all zero.
- [ ] **Test harness** — `vitest` is referenced in `package.json` but not installed,
  and no `*.test.ts` exists. Stand this up before filling in modules.

## 1. Infrastructure stubs
- [ ] **WebSocket server** — `realtime/websocket-server.ts` logs `ws.stub_server`
  and accepts nothing. Wire real `ws`: accept sockets, auth, heartbeat/ping-pong,
  route to `message-router` (§4).
- [ ] **Redis** — `redis/redis-client.ts` + `cart-cache.ts` are stubs
  (`redis.stub_client`). Back `RedisCartCache` with `ioredis`; active carts live
  here (§9, §11 invariant).
- [ ] **Postgres** — `db/db.ts` logs `db.stub_client`. Create a real `pg` Pool; the
  SQL schema (`db/schema/*.sql`) is written but **unverified against a live
  Postgres/Odoo**.
- [ ] **Logger** (optional) — `config/logger.ts` TODO: swap for `pino`, keep the
  interface.

## 2. STT / Voice (§5, §14)
- [ ] **Real STT client(s)** — `stt/stt-client.ts` returns `NoopSttProvider`
  (`stt_not_implemented`). Implement `AssemblyAiProvider` / `DeepgramProvider`
  behind the existing `SttProvider` interface; the factory `switch` already has the
  seams. (The interface abstraction is already done — this is the provider work.)
- [ ] **Final-transcript timeout** — `voice/voice-message-handler.ts:73` TODO: start
  `constants.TIMEOUTS.finalTranscriptMs` on `voice.stop`; fail the session if no
  final arrives in 2–5s (§11.2 case C).

## 3. Menu / Candidate Matcher (§7)
- [ ] **Embedding service** — `menu/embedding-service.ts` is a stub
  (`embedding.stub`); wire a real provider + re-embed on menu change.
- [ ] **Hybrid ranking** — `menu/candidate-matcher.ts` ships a naive
  substring/popularity matcher; add fuzzy-matcher + modifier-matcher + embedding
  similarity (§7).
- [ ] **Menu cache population** — `menu/menu-cache.ts` TODO: load from a
  menu-repository that reads the Odoo POS tables (`menu_restaurant_schema.md`).

## 4. LLM (§8, §11.3)
- [ ] **Real LLM client(s)** — `llm/llm-client.ts` is `name = 'stub'`
  (`llm.stub_provider_in_use`). Implement Groq/OpenAI/Gemini with retry + repair
  prompt + fallback model.

## 5. Ordering / LangGraph (§6, §9)
- [x] **Port to real LangGraph** — `ordering/order-graph.ts` is now a real
  `@langchain/langgraph` `StateGraph` (`graph/state.ts` + `graph/build-graph.ts`) with
  a `MemorySaver` checkpointer keyed `thread_id=${pos_config_id}:${cart_id}`.
- [x] **Clarification resume** — `clarify` node `interrupt()`s; the service resumes via
  `Command({resume})` while holding the per-cart FIFO slot (with a timeout).
- [x] **Schema-repair retry** — `nodes/parse-and-validate.node.ts` retries once with
  `buildRepairPrompt` on schema failure (§11.3 stages 2/3).
- [ ] **Supported languages** — `order-understanding-service.ts` TODO: source
  from `voice_restaurant_settings` instead of hardcoding `[]`.
- [x] **Replace hand-written validators** — `ordering/schemas/{cart-operation,order-graph-output}.schema.ts`
  now use `zod` (types inferred; `Result`-returning parsers).

## 6. Cart (§9)
- [ ] **Pricing/tax in applier** — `cart/cart-operation-applier.ts:14` TODO:
  modifier price deltas + tax recompute.
- [ ] **Persistence** — `cart/cart-repository.ts` is in-memory; TODO: back with
  Postgres (`processed_requests`, `cart_snapshots`) and, on confirm, create
  `pos_order`/`pos_order_line` in Odoo + record `voice_order_confirmations`
  (currently `cart.confirm_stub`).

## 7. Cross-cutting
- [ ] **Auth** — `auth/session-auth.ts` trusts query params; TODO: verify a signed
  token + look up the table's POS.
- [ ] **Metrics** — `observability/metrics.ts` is a no-op; back with a real registry
  (Prometheus/OTEL) — §11/§13 rely on connection-count / event-loop-lag metrics.
- [ ] **Server-call-to-table feature** (§1 functional req) — schema exists
  (`07_server_calls.sql`) but no handler wires it end-to-end; confirm/build.

---

## Open decisions
1. **Scope/priority** — end-to-end happy path first (STT → LLM → cart → WebSocket
   push, i.e. items 1, 2, 4, 6 + real deps), or one module fully finished (e.g. the
   STT provider swap)?
2. **Provider choices** — design's cheapest stack is AssemblyAI + Groq (§14). Target
   that, or keep both STT options behind the interface?
