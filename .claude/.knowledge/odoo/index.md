---
type: Index
title: odoo bundle
description: HTTP clients for Odoo — the goopter_cart_api JSON-RPC calls, plus an image proxy.
timestamp: 2026-07-22
---

# odoo

Everything this service sends to Odoo over HTTP. The JSON-RPC client for the `goopter_cart_api`
addon: the write path (maps a confirmed `Cart` onto the insert contract and POSTs it, on confirm)
plus a read-only price `quote` (on each cart apply). The addon lives in **another repo** —
`SPEC.md` is its contract, not built here. Separately, a transparent proxy for Odoo's public
`/web/image` route, so a browser can render menu photos.

- [overview.md](./overview.md) — purpose, mechanics, dependencies, files.
