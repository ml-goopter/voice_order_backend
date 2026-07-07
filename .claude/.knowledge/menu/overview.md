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
  (`modifier_key` ↔ `ptav_id`). Two load paths: `load()` (async) embeds each item's
  per-language names once via the injected `EmbeddingService`
  (`embedBatch(names, 'passage')`); `loadIndexed()` (sync) accepts
  `IndexedMenuItem`s whose vectors were **already computed at seed time** (the Redis
  boot path — no embedder call). Lookups by key and by `product_tmpl_id`.
- **Redis repository** (`menu-repository.ts`): `RedisMenuRepository` reads the
  seeded corpus written by `scripts/populate-redis-menu.ts` —
  `SMEMBERS menu:items:{pos}` → `MGET menu:item:{pos}:{id}` → maps each JSON record
  (`toMenuItem` / `toCandidateModifier`, en_US-first modifier name) into
  `IndexedMenuItem`s with the stored `vectors`. `listPosConfigIds()` scans
  `menu:meta:*`. `app.start()` loads every discovered pos via `loadIndexedMenu`. A
  read-time check warns when a stored vector's length ≠ `EMBEDDING_DIMENSIONS`.
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
- Default is still `stub` until `EMBEDDING_PROVIDER=jina` + `JINA_API_KEY` are set;
  seeding with the stub writes items with **no vectors** (matcher falls back to
  fuzzy/modifier). The `populate-redis-menu.ts` Postgres source still needs the
  `pg` package + an Odoo dump to run.
- Vectors are now **persisted in Redis** inside each item record, but retrieval is
  still an in-process cosine scan; a RediSearch/KNN vector index (§13) is the
  scale-up path beyond ~2,000 items.
