---
type: Index
title: odoo bundle
description: JSON-RPC client that inserts confirmed carts into the POS, and the Cart → request mapping.
timestamp: 2026-07-15
---

# odoo

The write path into the POS: maps a confirmed `Cart` onto the `goopter_cart_api` addon's
insert contract and POSTs it over JSON-RPC. The addon lives in **another repo** —
`SPEC.md` (repo root) is its contract, not something built here.

- [overview.md](./overview.md) — purpose, mechanics, dependencies, files.
