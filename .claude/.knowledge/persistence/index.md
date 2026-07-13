---
type: Index
title: persistence bundle
description: Redis for carts, Postgres/pgvector for the menu, and the Odoo-referenced source of truth.
timestamp: 2026-07-13
---

# persistence

Where state lives: Redis for hot active carts **and** our durable app state;
Postgres/pgvector (our `item_vector` table inside the Odoo DB) for the menu backend;
and Odoo POS (referenced by soft integer ids) for menu/restaurant/confirmed orders.

- [overview.md](./overview.md) — purpose, mechanics, dependencies, files.
