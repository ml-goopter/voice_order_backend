---
type: Concept
title: Menu Candidate Matcher
description: Hybrid KNN + lexical search over Redis, rank candidates, resolve LLM keys to Odoo ids.
resource: src/menu
timestamp: 2026-07-07
---

# Menu Candidate Matcher

## Purpose
Retrieves a small candidate set of items/modifiers for a transcript before the LLM
call — cuts token cost and improves accuracy (design §7). Also resolves LLM
`menu_item_key` back to Odoo `product_tmpl_id` for the Cart Module. Every request
reads Redis at query time; there is **no in-memory menu cache**.

## Mechanics
- **Store** (`menu-store.ts`): `MenuStore` is the query surface. `RedisMenuStore`
  reads the seeded item blobs (`menu:item:{pos}:{id}`) and searches the RediSearch
  index. Methods: `ensureIndex()`, `knnSearch(pos, queryVectors, k)` →
  `Map<product_tmpl_id, bestCosineSim>` (up to `k` DISTINCT items; over-fetches
  `k·4` docs to offset per-language doc explosion; similarity clamped to [0,1];
  per-phrase searches run concurrently and any FT error degrades to empty →
  fuzzy fallback), `lexicalSearch(pos, phrases)` → `Set<product_tmpl_id>` (FT TEXT
  match over the `name` field, fuzzy for words ≥ 4 chars), `getItems`/`allItems`
  (hydrate), `getItem` (by tmpl id), `getItemByKey` (via the `menu:key:*` secondary
  index, falling back to an item scan if it is absent). `toMenuItem`/
  `toCandidateModifier` map stored JSON → runtime `MenuItem` (en_US-first modifier
  name). Holds no state between calls. `InMemoryMenuStore` (`in-memory-menu-store.ts`)
  is the test double / Redis-free local option (KNN as an in-process cosine scan,
  lexical as substring+fuzzy); it is NOT wired into the production app.
- **Index** (`menu-index.ts`): `idx:menuvec`, a RediSearch index over prefix
  `menu:vec:` combining a FLAT/COSINE vector field with a `name` TEXT field. KNN
  needs one vector per document, but an item carries a multi-vector array (one name
  per language), so each (item, language) name is exploded into its own HASH doc
  `menu:vec:{pos}:{tmpl}:{i}` = `{ pos(TAG), tmpl(NUMERIC), name(TEXT),
  vector(FLOAT32 blob) }`. A single index spans all restaurants; `pos` is a TAG
  pre-filter. **Availability is not indexed** — it is a mutable fact filtered at
  read time from the source blob (`rank()`), so re-enabling an item needs no
  reindex. `ensureMenuIndex()` no-ops when dims ≤ 0 and records a schema+dim
  signature (`menu:index:meta`): an up-to-date index is a cheap no-op, and a stale
  one (dimension changed, or the `SCHEMA_VERSION` bumped) is dropped + recreated.
  **Requires the RediSearch module (Redis Stack / Redis 8)**; on plain Redis the
  FT.* calls error and the matcher falls back to a fuzzy scan.
- **Matcher** (`candidate-matcher.ts`): retrieve-then-rerank. `chunk()` splits the
  transcript into item/modifier phrases; `match()` embeds all phrases in one
  `embedBatch(phrases, 'query')`, then retrieves a candidate **union** of KNN hits
  (`knnSearch`) and lexical name matches (`lexicalSearch`) run concurrently — so a
  lexically-close item the vector recall misses is still surfaced — hydrates the
  union, then hybrid-ranks by `W_EMBED·emb + W_FUZZY·fuzzy + W_MODIFIER·modifier`,
  drops those below `SCORE_THRESHOLD` (and unavailable items), and returns the top
  `LIMITS.maxCandidatesToLlm`. When no embeddings exist (stub embedder, empty query
  vectors, or nothing retrieved) it falls back to a fuzzy/modifier scan over
  `allItems(pos)`.
- **Signals**: `fuzzy-matcher.ts` (`similarity()` — normalised Levenshtein +
  substring); `modifier-matcher.ts` (`modifierMatchScore()` — best phrase↔modifier
  similarity above a threshold).
- **Service** (`menu-service.ts`): facade over a `MenuStore` + `CandidateMatcher`.
  `ensureIndex` (boot), `getCandidates` (async hybrid match), and the async
  `MenuLookup` methods `resolveItemKey`/`findByTmplId`/`getItems` the Cart Module
  consumes (`getItems` batch-hydrates for repricing). Injects an `EmbeddingService`
  (default `createEmbeddingService()`).
- **Embedding provider** (`embedding-service.ts`): `EmbeddingService` interface
  (`model`, `dimensions`, `embed`/`embedBatch` with an optional
  `role: 'query' | 'passage'`); `createEmbeddingService()` is the single swap point
  (`EMBEDDING_PROVIDER`). `StubEmbeddingService` returns `[]` (dimensions 0 →
  fuzzy fallback); `JinaEmbeddingService` (`jina-embedding-service.ts`) calls Jina
  `/v1/embeddings` (`jina-embeddings-v3`, 1024 dims, normalized).

## Seeding & indexing (additive, derived layer)
- `scripts/populate-redis-menu.ts` (from Odoo Postgres) and
  `scripts/embed-redis-menu.ts` (`npm run embed:menu`, backfill embeddings into an
  already-seeded Redis) write the item blobs and their per-language `vectors`.
- `scripts/index-redis-menu.ts` (`npm run index:menu`) projects the search layer
  from the existing blobs: it reads each `menu:item:*` record and writes the derived
  `menu:vec:*` docs (`{ pos, tmpl, name, vector }`) + `menu:key:*` lookups + ensures
  the index (rebuilding it if the dimension/schema changed). Vectors whose width ≠
  `EMBEDDING_DIMENSIONS` are skipped (RediSearch can't index them). Purely additive
  — it never mutates `menu:item`/`menu:items`/`menu:meta`; it only clears and
  rewrites its own derived keys per pos (idempotent).

## Dependencies
- `ioredis` (Redis Stack / RediSearch); `config/constants` (`LIMITS`); `config/env`
  (`REDIS_URL`, `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`,
  `JINA_API_KEY`, `JINA_BASE_URL`).

## Key files
- `menu-service.ts` (`MenuService`, `MenuLookup`), `menu-store.ts`
  (`MenuStore`, `RedisMenuStore`, mapping helpers), `menu-index.ts`
  (index + vector encoding), `in-memory-menu-store.ts` (test/dev store).
- `candidate-matcher.ts`, `menu-types.ts`.
- `fuzzy-matcher.ts`, `modifier-matcher.ts` — pure ranking signals (unit-tested).
- `embedding-service.ts`, `jina-embedding-service.ts`.
- `scripts/populate-redis-menu.ts`, `scripts/embed-redis-menu.ts`,
  `scripts/index-redis-menu.ts`.
- `*.test.ts` — matchers, the Jina client, `RedisMenuStore` reads, and the matcher
  (via `InMemoryMenuStore`).

## Not done yet
- Default is still `stub` until `EMBEDDING_PROVIDER=jina` + `JINA_API_KEY` are set;
  with the stub (or before `index:menu` runs) the matcher falls back to fuzzy/
  modifier. `populate-redis-menu.ts` still needs the `pg` package + an Odoo dump.
