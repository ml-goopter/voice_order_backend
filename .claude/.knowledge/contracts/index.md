---
type: Index
title: contracts bundle
description: Neutral cross-module wire contracts (DTOs/schemas) shared between modules.
timestamp: 2026-07-16
---

# contracts

Dependency-light DTOs and zod schemas that more than one module speaks. Extracted
here so no business module has to reach into a sibling for a shared shape (which had
forced a reversed `llm` → `ordering` dependency and coupled `events` to `ordering`).
`contracts/` imports only from `shared/` and external libs — never from a business
module — so it can sit at the bottom of the dependency graph.

- [overview.md](./overview.md) — purpose, mechanics, dependencies, files.
