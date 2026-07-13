---
type: Index
title: menu bundle
description: Candidate matching before the LLM via Postgres/pgvector KNN search.
timestamp: 2026-07-13
---

# menu

Finds likely items/modifiers before the LLM call so the whole menu is never sent
(design §7). Matches with a per-request pgvector KNN search over an `item_vector`
table (in the Odoo DB), JOINing Odoo tables for live metadata (no in-memory cache);
keyed by `product_tmpl_id` / `ptav_id`.

- [overview.md](./overview.md) — purpose, mechanics, dependencies, files.
