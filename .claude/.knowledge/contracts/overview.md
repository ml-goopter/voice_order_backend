---
type: Concept
title: Cross-module contracts
description: Shared DTOs/schemas (cart operations, proposal, prompt cart view, intent) with no business-module deps.
resource: src/contracts
timestamp: 2026-07-22
---

# Cross-module contracts

## Purpose
The wire shapes multiple modules must agree on, in a neutral module so the dependency
arrows stay one-directional. Before extraction these lived under `ordering/schemas/`,
which forced `llm` (a generic infra module) to import `ordering`, and made `events`
depend on a business module for its payload types. Everything here is owned by no single
module and depended on by several.

## Mechanics
- **`cart-operation.schema.ts`** — the zod `cartOperationSchema` (discriminated union on
  `action`: `add_item` / `remove_item` / `update_quantity` / `add_modifier` /
  `remove_modifier`) + inferred `CartOperation` type + `parseCartOperation` (Result-returning).
  The LLM output contract *and* what the cart module validates on apply — one source of truth.
- **`proposal.ts`** — `OrderProposal`: the batch of operations + `base_version` that Order
  Understanding hands the Cart module (payload of `order.operations_proposed`).
- **`cart-view.ts`** — prompt-facing cart projections (`CartView` / `CartLineView` /
  `CartModifierView`) + `HistoryTurn`. What the agent sees: keys/names/per-unit prices, no
  numeric ids, no totals. (Was `ordering/schemas/order-graph-input.schema.ts`.)
- **`intent.ts`** — the classifier output contract: `intentSchema` (`z.enum(['service','junk'])`),
  `Intent`, `DEFAULT_INTENT`. The langgraph routing table `INTENT_ROUTE` deliberately stays in
  `ordering/graph/intents.ts` (it needs `END`); only the label set is shared here.
- **`mentioned-item.ts`** — `MentionedItem` (`menu_item_key`, `product_tmpl_id`, `name`,
  `base_price_cents`, optional `popularity`): a menu item the agent named in a spoken reply,
  carried on `order.reply` so the client can render what was spoken. Every field is echoed
  server-side from the search result the agent was shown — the agent supplies only the key — so the
  model can never mis-state a price. `available_modifiers` is deliberately omitted (a spoken
  suggestion is not a configurator). `PopularityTier` lives here too, and `menu/menu-types.ts`
  re-exports it: the canonical definition must sit in `contracts` because a contract type uses it
  and `contracts` may not import from `menu`.

## Dependencies
- `zod` (schemas), `shared/{types,result,errors,zod-error}`. **No business-module imports** —
  this is the invariant that keeps the graph acyclic. Consumed by `cart`, `llm`, `events`,
  and `ordering`.

## Key files
- `cart-operation.schema.ts` (+ `cart-operation.schema.test.ts`) — `cartOperationSchema`, `CartOperation`, `parseCartOperation`.
- `proposal.ts` — `OrderProposal`.
- `cart-view.ts` — `CartView`, `CartLineView`, `CartModifierView`, `HistoryTurn`.
- `intent.ts` — `intentSchema`, `Intent`, `DEFAULT_INTENT`.
