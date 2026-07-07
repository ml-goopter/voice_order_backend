---
type: Index
title: persistence bundle
description: Redis for all our state (hot + durable) and the Odoo-referenced source of truth.
timestamp: 2026-07-07
---

# persistence

Where state lives: Redis for hot active carts **and** our durable app state, and
Odoo POS (referenced by soft integer ids) for menu/restaurant/confirmed orders.
No local Postgres.

- [overview.md](./overview.md) — purpose, mechanics, dependencies, files.
