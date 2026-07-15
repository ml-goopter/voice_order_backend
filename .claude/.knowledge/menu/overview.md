---
type: Concept
title: Menu Candidate Matcher
description: Hybrid KNN + lexical search over Postgres/pgvector, rank candidates, resolve LLM keys to Odoo ids.
resource: src/menu
timestamp: 2026-07-13
---

# Menu Candidate Matcher

## Purpose
Retrieves a small candidate set of items/modifiers for a transcript before the LLM
call — cuts token cost and improves accuracy (design §7). Also resolves LLM
`menu_item_key` back to Odoo `product_tmpl_id` for the Cart Module. Every request
reads the store at query time; there is **no in-memory menu cache**.

## Backend
The runtime menu backend is **Postgres/pgvector** (`PostgresMenuStore`), wired in
`app.ts`. The menu module no longer contains any Redis code — Redis is now used
solely by the Cart Module (cart persistence). The `InMemoryMenuStore` remains as
the test/dev double.

## Mechanics
- **Store** (`postgres-menu-store.ts`): `PostgresMenuStore` is the production query
  surface, implementing `MenuStore` over an `item_vector` table that lives **inside
  the Odoo Postgres DB**. `item_vector(pos_config_id, product_tmpl_id,
  menu_item_key, lang, name, vector)` holds the per-restaurant membership + LLM key
  + one pgvector row per (item, language) name — the pgvector analogue of the
  RediSearch per-language doc explosion. It carries NO item metadata: hydration
  JOINs Odoo's own read-only tables (`product_template` for names(jsonb)/
  `list_price`/`available_in_pos`/`active`; `product_template_attribute_value` ⋈
  `product_attribute_value` ⋈ `product_attribute` for modifiers). `knnSearch` runs
  pgvector `<=>` cosine distance (`sim = 1 - dist`, clamped [0,1], one query per
  phrase, `k·4` over-fetch, best sim per DISTINCT tmpl); `lexicalSearch` is
  `name ILIKE ANY(%term%)`; hydration maps `base_price_cents = round(list_price·100)`,
  `available = available_in_pos AND active`, `modifier_key = String(ptav_id)`,
  `price_extra_cents = round(ptav.price_extra·100)` (the per-unit surcharge; read per
  ptav, since the same option value may be priced differently on another item),
  modifier `name` en_US-first plus a full `names` map (`namesOf`, value-names else the
  attribute's, for the client). `ensureIndex()` runs idempotent DDL (`CREATE EXTENSION
  vector`, `CREATE TABLE item_vector`, a `(pos,tmpl)` btree + an HNSW
  `vector_cosine_ops` index); no-ops when `dims <= 0`. Any query error degrades to
  empty → the matcher's fuzzy fallback. Uses a shared `pg.Pool`
  (`db/postgres-client.ts`). `pos_config_id` scoping lives entirely in `item_vector`
  (Odoo's `available_in_pos` is a global flag).
- **Interface** (`menu-store.ts`): the `MenuStore` interface only — the contract
  the matcher and cart lookups run against (`ensureIndex`, `knnSearch`,
  `lexicalSearch`, `getItems`, `allItems`, `getItem`, `getItemByKey`).
  `InMemoryMenuStore` (`in-memory-menu-store.ts`) is the test/dev double (KNN as an
  in-process cosine scan, lexical as substring+fuzzy); it is NOT wired into the
  production app.
- **Store, Redis (unwired)** (`menu-store.ts`): `MenuStore` interface + mapping
  helpers (`toMenuItem`/`toCandidateModifier`). `RedisMenuStore`
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
  name plus the full `names` map). Holds no state between calls. `InMemoryMenuStore` (`in-memory-menu-store.ts`)
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

## Seeding & indexing
- **Postgres (wired):** `scripts/populate-postgres-menu.ts` (`npm run seed:menu:pg`)
  seeds `item_vector` for one `POS_CONFIG_ID`: reads `available_in_pos AND active`
  templates from Odoo, slugifies a stable `menu_item_key`, embeds each language name
  (role `passage`), and rewrites this pos's rows in one transaction (idempotent).
  Needs a real embedder (`EMBEDDING_PROVIDER≠stub`).

## Dependencies
- `pg` (Postgres/pgvector, the production backend) + `db/postgres-client.ts`;
  `config/constants` (`LIMITS`); `config/env` (`ODOO_DATABASE_URL`,
  `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `JINA_API_KEY`,
  `JINA_BASE_URL`). No Redis dependency — the menu module is Redis-free.

## Key files
- `menu-service.ts` (`MenuService`, `MenuLookup`), `postgres-menu-store.ts`
  (`PostgresMenuStore` — the wired backend, vector encoding, lexical terms),
  `menu-store.ts` (`MenuStore` interface only), `in-memory-menu-store.ts`
  (test/dev store).
- `candidate-matcher.ts`, `menu-types.ts`.
- `fuzzy-matcher.ts`, `modifier-matcher.ts` — pure ranking signals (unit-tested).
- `embedding-service.ts`, `jina-embedding-service.ts`.
- `scripts/populate-postgres-menu.ts` (wired backend seed).
- `*.test.ts` — matchers, the Jina client, `PostgresMenuStore` (fake `pg.Pool`),
  and the matcher (via `InMemoryMenuStore`).

## Not done yet
- Default is still `stub` until `EMBEDDING_PROVIDER=jina` + `JINA_API_KEY` are set;
  with the stub (or before `seed:menu:pg` runs) `item_vector` is empty and the
  matcher falls back to fuzzy/modifier over an empty corpus. Needs a real embedder +
  a live Odoo DB with the pgvector extension.
