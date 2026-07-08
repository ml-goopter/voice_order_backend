---
type: Index
title: menu bundle
description: Candidate matching before the LLM via Redis KNN vector search.
timestamp: 2026-07-07
---

# menu

Finds likely items/modifiers before the LLM call so the whole menu is never sent
(design §7). Matches with a per-request RediSearch KNN vector search over Redis (no
in-memory cache); keyed by `product_tmpl_id` / `ptav_id`.

- [overview.md](./overview.md) — purpose, mechanics, dependencies, files.
