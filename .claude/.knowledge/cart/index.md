---
type: Index
title: cart bundle
description: The only module that mutates cart state — validate, apply, persist.
timestamp: 2026-07-07
---

# cart

The sole writer of cart state (design §9): validates proposed operations, applies
valid ones, rejects invalid ones, versions + persists, emits `cart.updated`, and
confirms carts into Odoo `pos_order`.

- [overview.md](./overview.md) — purpose, mechanics, dependencies, files.
