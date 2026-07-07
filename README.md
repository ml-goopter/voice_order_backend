# Voice-Based Ordering

Event-driven modular monolith (TypeScript, ESM) implementing the architecture in
[`design.cleaned.md`](./design.cleaned.md). This is a **scaffold**: module boundaries,
the typed event bus, WebSocket/LLM/cart contracts, and the concurrency machinery are
in place; external systems are behind interfaces with in-memory/stub implementations.

## Quick start

```bash
npm run typecheck   # tsc --noEmit (green out of the box)
npm run build       # emit dist/
npm start           # boots the composition root (stub providers)
npm run dev         # watch mode (needs: npm i -D tsx)
```

No external services required to boot — Redis, Postgres, STT, LLM, and the WebSocket
server are stubbed and log a warning when used.

## Module map (design §2, §12)

```
realtime/   WebSocket gateway, client registry, message routing        (design §4)
voice/      voice sessions, STT streaming, emits final transcript       (design §5)
stt/        cloud STT provider interface (+ noop stub)                  (design §14)
ordering/   transcript → proposed ops / clarification (LangGraph-style)  (design §6/§8)
  ├ nodes/      normalize → load-cart → candidates → parse → validate
  ├ schemas/    cart-operation, graph input/output, proposal, clarify
  └ cart-turn-queue.ts   per-cart understanding FIFO (Tier 1)          (design §9)
menu/       in-memory cache + candidate matcher + embeddings            (design §7)
llm/        cloud LLM interface + prompt builder (+ stub)               (design §8)
cart/       ONLY writer of cart state: validate → apply → persist       (design §9)
redis/      cart cache (in-memory default; Redis TODO)
db/         Postgres access (stub) + schema/*.sql
events/     typed in-process event bus + event contracts               (design §2)
shared/     Result, errors, ids, keyed async lock
```

## End-to-end flow (wired via the event bus)

```
ws voice.audio_chunk → Voice/STT → (partial → client)
                                  → stt.final_transcript.received
  → OrderUnderstanding (per-cart FIFO → graph: match → LLM → validate)
  → order.operations_proposed
  → CartController (apply lock → rebase per op → version++ → persist)
  → cart.updated → gateway broadcasts to every socket on the cart
```

## What is real vs stubbed

**Real:** typed event bus & contracts, WS message parsing, cart operation
validate/apply (line_id assignment, modifier resolution, rejection reasons),
per-cart FIFO + apply lock + optimistic version/rebase (design §9), idempotency
guard, candidate matching (naive), reconnect/resume snapshot response.

**Stubbed (search `TODO`):** STT clients (§14), LLM clients (§8/§14), LangGraph
pause/resume checkpointer (§6), Redis (`ioredis`), Postgres (`pg`), the `ws` server,
embeddings, and Odoo menu loading (`seed-menu`).

## Planned dependencies (not yet installed)

Runtime: `ws`, `ioredis`, `pg`, `zod` (replace hand-written validators),
`@langchain/langgraph`, provider SDKs. Dev: `tsx`, `vitest`.
Data schema: [`src/db/schema/`](./src/db/schema/README.md) (Odoo POS + our tables).
```
