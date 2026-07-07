---
type: Concept
title: Menu Candidate Matcher
description: Chunk transcript, rank candidates, resolve LLM keys to Odoo ids.
resource: src/menu
timestamp: 2026-07-07
---

# Menu Candidate Matcher

## Purpose
Retrieves a small candidate set of items/modifiers for a transcript before the LLM
call — cuts token cost and improves accuracy (design §7). Also resolves LLM
`menu_item_key` back to Odoo `product_tmpl_id` for the Cart Module.

## Mechanics
- **In-memory cache** (`menu-cache.ts`): `Map<pos_config_id, IndexedMenuItem[]>`,
  fine below ~2,000 items (§7). `MenuItem` carries translated `names` keyed by Odoo
  `res.lang` code, `base_price_cents`, availability, and its modifiers
  (`modifier_key` ↔ `ptav_id`). At load (async) each item's per-language names are
  embedded once via the injected `EmbeddingService` (`embedBatch(names, 'passage')`)
  into `MenuVector`s; lookups by key and by `product_tmpl_id`.
- **Matcher** (`candidate-matcher.ts`): `chunk()` splits the transcript into
  item/modifier phrases; `match()` embeds all phrases in one `embedBatch(phrases,
  'query')`, then hybrid-ranks every available item by
  `W_EMBED·cosine + W_FUZZY·fuzzy + W_MODIFIER·modifier`, drops those below
  `SCORE_THRESHOLD`, and returns the top `LIMITS.maxCandidatesToLlm`. With the stub
  embedder (empty vectors) the embedding term is 0 and ranking falls back to fuzzy
  + modifier.
- **Signals**: `fuzzy-matcher.ts` (`similarity()` — normalised Levenshtein +
  substring); `modifier-matcher.ts` (`modifierMatchScore()` — best phrase↔modifier
  similarity above a threshold).
- **Service** (`menu-service.ts`): facade — `loadMenu`, `getCandidates` (async),
  `resolveItemKey`, `findByTmplId`; injects an `EmbeddingService` (default
  `createEmbeddingService()`).
- **Embedding provider** (`embedding-service.ts`): `EmbeddingService` interface
  (`model`, `dimensions`, `embed`/`embedBatch` with an optional
  `role: 'query' | 'passage'`); `createEmbeddingService()` is the single swap point
  (`EMBEDDING_PROVIDER`), mirroring `createLlmProvider`/`createSttProvider`.
  `StubEmbeddingService` returns `[]`; `JinaEmbeddingService`
  (`jina-embedding-service.ts`) calls Jina `/v1/embeddings` (`jina-embeddings-v3`,
  1024 dims), batching all inputs per call, `index`-ordered, one retry on 429/5xx.

## Dependencies
- `config/constants` (`LIMITS`); `config/env` (`EMBEDDING_PROVIDER`,
  `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `JINA_API_KEY`, `JINA_BASE_URL`).

## Key files
- `menu-service.ts`, `menu-cache.ts`, `candidate-matcher.ts`, `menu-types.ts`.
- `fuzzy-matcher.ts`, `modifier-matcher.ts` — pure ranking signals (unit-tested).
- `embedding-service.ts` — interface + `StubEmbeddingService` + factory.
- `jina-embedding-service.ts` — real Jina provider (default when `EMBEDDING_PROVIDER=jina`).
- `*.test.ts` — Vitest coverage for the three matchers + the Jina client.

## Not done yet
- Default is still `stub` until `EMBEDDING_PROVIDER=jina` + `JINA_API_KEY` are set.
- Embeddings are **in-memory only** (not persisted to Postgres). At scale, a
  Redis vector cache could replace the in-memory per-phrase vector loop (§13);
  loading `MenuItem`s from the Odoo POS tables (`seed-menu`) is still pending.
