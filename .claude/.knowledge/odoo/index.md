---
type: Index
title: odoo bundle
description: JSON-RPC client for the goopter_cart_api addon — inserts confirmed carts and quotes prices.
timestamp: 2026-07-16
---

# odoo

The JSON-RPC client for the `goopter_cart_api` addon: the write path (maps a confirmed `Cart`
onto the insert contract and POSTs it, on confirm) plus a read-only price `quote` (on each cart
apply). The addon lives in **another repo** — `SPEC.md` is its contract, not built here.

- [overview.md](./overview.md) — purpose, mechanics, dependencies, files.
