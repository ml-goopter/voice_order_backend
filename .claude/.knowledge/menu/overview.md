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
- **In-memory cache** (`menu-cache.ts`): `Map<pos_config_id, MenuItem[]>`, fine
  below ~2,000 items (§7). `MenuItem` carries translated `names` keyed by Odoo
  `res.lang` code, `base_price_cents`, availability, popularity, and its modifiers
  (`modifier_key` ↔ `ptav_id`). Lookups by key and by `product_tmpl_id`.
- **Matcher** (`candidate-matcher.ts`): `chunk()` splits the transcript into
  item/modifier phrases; `match()` scores available items by naive substring +
  popularity and returns the top `LIMITS.maxCandidatesToLlm`.
- **Service** (`menu-service.ts`): facade — `loadMenu`, `getCandidates`,
  `resolveItemKey`, `findByTmplId`.

## Dependencies
- `config/constants` (`LIMITS`). `embedding-service.ts` is a stub.

## Key files
- `menu-service.ts`, `menu-cache.ts`, `candidate-matcher.ts`, `menu-types.ts`.
- `embedding-service.ts` — **stub** (`StubEmbeddingService` returns `[]`).

## Not done yet
- Real hybrid ranking (embedding similarity + fuzzy + alias + modifier +
  popularity, across multi-language vectors, §7/§15); embeddings + `menu_embeddings`
  (pgvector); loading `MenuItem`s from the Odoo POS tables (`seed-menu`).
