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
  embedded once via the injected `EmbeddingService` into `MenuVector`s; lookups by
  key and by `product_tmpl_id`.
- **Matcher** (`candidate-matcher.ts`): `chunk()` splits the transcript into
  item/modifier phrases; `match()` embeds each phrase once, then hybrid-ranks every
  available item by `W_EMBED·cosine + W_FUZZY·fuzzy + W_MODIFIER·modifier`, drops
  those below `SCORE_THRESHOLD`, and returns the top `LIMITS.maxCandidatesToLlm`.
  With the stub embedder (empty vectors) the embedding term is 0 and ranking falls
  back to fuzzy + modifier.
- **Signals**: `fuzzy-matcher.ts` (`similarity()` — normalised Levenshtein +
  substring); `modifier-matcher.ts` (`modifierMatchScore()` — best phrase↔modifier
  similarity above a threshold).
- **Service** (`menu-service.ts`): facade — `loadMenu`, `getCandidates` (async),
  `resolveItemKey`, `findByTmplId`; injects an `EmbeddingService` (default
  `StubEmbeddingService`).

## Dependencies
- `config/constants` (`LIMITS`). `embedding-service.ts` is a stub.

## Key files
- `menu-service.ts`, `menu-cache.ts`, `candidate-matcher.ts`, `menu-types.ts`.
- `fuzzy-matcher.ts`, `modifier-matcher.ts` — pure ranking signals (unit-tested).
- `embedding-service.ts` — **stub** (`StubEmbeddingService` returns `[]`).
- `*.test.ts` — Vitest coverage for the three matchers.

## Not done yet
- Real embedding provider (`StubEmbeddingService` returns `[]`) + `menu_embeddings`
  (pgvector) or Redis vector search to replace the per-phrase vector loop at scale
  (§13); loading `MenuItem`s from the Odoo POS tables (`seed-menu`).
