# CLAUDE.md

## Requirements

Event-driven modular monolith: modules communicate only through the typed in-process
event bus. Each requirement below is stated so it can be verified by a test or assertion.

### cart
- Is the only module that mutates cart state.
- On `client.connected`, creates the cart with a set-once identity (`device_id`, plus
  `table_id` for dine-in); a reconnect or second device never rewrites it.
- On `order.operations_proposed`: rejects a duplicate `request_id` as a no-op; rejects
  every op when the cart is confirmed (`cart_confirmed`); re-validates each op against the
  current version (stale edits reject individually, `add_item` always applies).
- Serializes writes per `cart_id` (apply lock) so batches are atomic.
- Re-prices each apply from the live menu: `(base + Σ modifier surcharge) × qty` (tax TODO).
- Emits `cart.updated` on success and one `cart.operation_rejected` per failed op.
- `POST /v1/carts/:cart_id/confirm` inserts into Odoo idempotently (second confirm returns
  the stored id, no re-insert); freezes the cart; 404 unknown cart, 502 on Odoo failure.

### events
- Defines `AppEventMap` (event name → payload) for all cross-module events.
- `emit`/`on`/`off` are type-checked against the map (wrong payload fails to compile).
- One shared singleton bus; delivery is in-process only.
- Emits one `event.emit` DEBUG line per event carrying `request_id`/`cart_id`/`session_id`
  when present (requires `LOG_LEVEL=debug`).

### menu
- Returns a ranked candidate set of items/modifiers for a transcript, capped at
  `LIMITS.maxCandidatesToLlm`.
- Resolves `menu_item_key` → `product_tmpl_id` for the cart module.
- Reads Postgres/pgvector at query time (no menu cache); scopes results by `pos_config_id`.
- Retrieval is KNN ∪ lexical, re-ranked; degrades to fuzzy scan when embeddings are absent.
- `searchMenu` applies price filters and popularity in one call; popularity ranks by order
  quantity (never revenue) and drops net-refunded items.

### ordering
- Turns `stt.final_transcript.received` into an `OrderProposal` (ops + `base_version`) and/or a
  spoken `order.reply` — a `propose_cart` may bundle a confirmation, so a turn can emit both — never
  writes the cart.
- An `order.reply` carries `mentioned_items` only for keys the agent retrieved via `search_menu`
  **this turn**; an unresolved key is dropped with a warn, never a lookup and never an error.
- Processes one turn per `cart_id` at a time, in arrival order (turn N sees turn N-1's result).
- `junk` utterances short-circuit to END and are not recorded to history; a turn following
  an `agent_reply` is force-routed as `service`.
- Agent loop is bounded by `LIMITS.maxAgentSteps`; exhaustion fails with `agent_step_limit`.
- `propose_cart` with empty/invalid operations is a retryable tool error, not a silent
  empty proposal.
- Carries `cart_view` + `history` across turns, checkpointed per `pos_config_id:cart_id`.

### realtime
- One WebSocket per app; owns no cart logic (only relays module output).
- Rejects a connection missing `session_id`/`cart_id`/`pos_config_id`/`device_id` with close
  code `4001`; `table_id` is optional.
- Emits `client.connected` at connect (the only entry point for identity).
- Broadcasts `cart.updated` to every socket on the `cart_id`; sends
  `order.clarification_needed`/`cart.operation_rejected` to the originating session (else the
  whole cart).
- Answers `connection.resume` with a `connection.resumed` cart snapshot.
- On `order.reply`, sends reply text (plus its `mentioned_items`, when present) and streamed
  `tts.*` audio frames to the session socket; TTS receives only the text and its language.


## Skills
### Knowledge-base-maintance
- use this skill whenever you make changes to the code base