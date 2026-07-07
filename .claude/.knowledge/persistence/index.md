---
type: Index
title: persistence bundle
description: Redis cart cache, Postgres access, and the Odoo-referenced SQL schema.
timestamp: 2026-07-07
---

# persistence

Where state lives: Redis for hot active carts, Postgres for our tables, and Odoo
POS (referenced by soft integer ids) for menu/restaurant/confirmed orders.

- [overview.md](./overview.md) — purpose, mechanics, dependencies, files.
