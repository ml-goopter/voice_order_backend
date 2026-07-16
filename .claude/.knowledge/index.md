---
type: Index
title: Knowledge Base — Voice-Based Ordering
description: Top-level directory of module bundles for the event-driven modular monolith.
timestamp: 2026-07-07
---

# Knowledge Base

Durable map of the codebase. Architecture and rationale live in
[`design.cleaned.md`](../../design.cleaned.md); the menu/restaurant source of
truth is [`menu_restaurant_schema.md`](../../menu_restaurant_schema.md) (Odoo POS).
[`SPEC.md`](../../SPEC.md) is the contract for the **`goopter_cart_api` Odoo addon** we
push confirmed carts to — it is implemented in another repo, not built here.

The system is a TypeScript (ESM, `nodenext`) **event-driven modular monolith**:
modules talk only through the typed in-process event bus; direct calls stay within
a module. Current state is a **scaffold** — contracts, wiring, and concurrency
machinery are real; external systems (STT, LLM, Redis, Postgres, `ws`, LangGraph)
sit behind interfaces with stub implementations (search `TODO`).

## Module bundles

| Bundle | Responsibility |
|---|---|
| [realtime](./realtime/index.md) | WebSocket gateway, routing, client registry, reconnect (design §4) |
| [voice](./voice/index.md) | Voice sessions + STT streaming; emits final transcript (design §5) |
| [tts](./tts/index.md) | Synthesizes order.reply text with Cartesia (multilingual); streams tts.* audio to the client |
| [ordering](./ordering/index.md) | Transcript → proposed ops / clarification; per-cart FIFO (design §6/§8) |
| [menu](./menu/index.md) | Candidate matching before the LLM; Postgres/pgvector + Odoo JOINs (design §7) |
| [llm](./llm/index.md) | Cloud LLM abstraction + prompt building (design §8) |
| [cart](./cart/index.md) | Sole writer of cart state: validate → apply → persist (design §9) |
| [odoo](./odoo/index.md) | JSON-RPC client that inserts confirmed carts into the POS (contract: `SPEC.md`) |
| [events](./events/index.md) | Typed in-process event bus + event contracts (design §2) |
| [contracts](./contracts/index.md) | Neutral cross-module wire shapes (cart operations, proposal, prompt cart view, intent) |
| [persistence](./persistence/index.md) | Redis (carts), Postgres/pgvector (menu), Odoo-referenced source of truth |
| [platform](./platform/index.md) | Config, shared utils, auth, REST router, composition root |

## Change history

See [log.md](./log.md) (newest first).
