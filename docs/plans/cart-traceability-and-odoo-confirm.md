# Plan: cart traceability (device/table identity), confirmation lock, Odoo cart insert

## Context / why

`SPEC.md` (repo root) describes **`goopter_cart_api`** — an **Odoo 19 addon** that *receives*
carts. It is already implemented and lives in a **different repo**. It is the **contract we code
against**, not something to build here. It exposes two JSON-RPC routes:

- `POST /goopter_cart_api/v1/cart` — insert (append-only) — **this is what we call**
- `POST /goopter_cart_api/v1/quote` — price without creating — **out of scope, see below**

This repo is the **external service** SPEC refers to. `src/cart/cart-types.ts` is field-for-field
the `Cart`/`CartLine`/`CartModifier` shape SPEC reproduces in its § "Mapping from the external
service's `Cart`". Read that section — it is the mapping table we implement.

Three gaps today:

1. **Nothing calls Odoo.** `RedisCartRepository.confirmOrder` (`cart-repository.ts:78`) is a `TODO`
   that logs `cart.confirm_stub` and returns `0`. `CartController.confirm` (`cart-controller.ts:112`)
   already has the exact shape we need (apply lock → read cart → hand to repo) and **nothing calls
   it**. This feature is largely "expose `confirm()` over HTTP and fill in the stub."
2. **There is no REST API.** The only HTTP server is inside `websocket-server.ts:27` — a bare
   `node:http` `createServer` answering `GET /health` and 404ing everything else, with `ws` attached
   at `/ws`. `src/api/health.routes.ts` is one function whose docstring says "Wire to an HTTP server
   as needed." No Express/Fastify in `package.json`.
3. **Carts have no durable identity.** `session_id` is **not** on `Cart` and cannot be filtered on —
   the only `session_id → cart_id` link is `ClientRegistry`'s in-memory map
   (`client-registry.ts:19-20`), which is process memory and dies on disconnect. `RestaurantTableId`
   exists at `shared/types.ts:20` — **declared, never used anywhere**.

## Decided design (do not re-litigate)

- **`SPEC.md` is the far side's contract.** Do not reimplement, second-guess, or "fix" it. Do not
  port the Odoo addon into this repo.
- **`device_id` (total) + `table_id` (partial). NOT a tagged union.** Every cart has a device —
  something is always talking to us. Only dine-in has a table. A dine-in cart legitimately has
  **both**, so a union would be wrong. Absent `table_id` = takeout/untabled, which SPEC explicitly
  supports (§ "Is a table mandatory?" → No; yields an untabled order).
- **Index both** — `device:{device_id}` and `table:{table_id}` → sets of cart_ids.
- **Identity is stamped at connect, not at confirm.** It must exist before the cart is written or
  in-flight carts miss the index, which is the whole point of the index.
- **Therefore the confirm endpoint takes no body** — the cart already knows its table.
- **Confirmed carts reject all further operations** (the "confirmation lock").
- **Hand-rolled routing on the existing `node:http` server. No framework.** Two routes do not
  justify adding Express/Fastify to a WebSocket-first app.
- **`ClientRegistry`'s `Set` and its "multi-device / reconnect" docstring STAY.** They are **not
  stale** — they echo `design.md:503-506` (§ "Concurrency on a shared cart"), which is the stated
  rationale for the entire Tier-1/Tier-2 concurrency design (turn queue, apply lock, per-op rebase).
  Collapsing `byCart` to a single connection introduces a real bug: on reconnect the old socket's
  late `close` (up to `heartbeatTimeoutMs` 30s / `reconnectWindowMs` 60s, `constants.ts:11,13`)
  would `delete` the *live new* socket, silently killing `cart.updated` delivery. Tests
  `client-registry.test.ts:51` and `:62` pin this. **Do not touch this file except the docstring
  clarification in §4c.**
- **Out of scope:** the `/quote` route; pricing divergence; retry/queue when Odoo is down;
  `preset_id` (see § Takeout below).

### Why identity does NOT thread through the ordering module

The tempting path is `SttFinalTranscriptReceived` (`event-types.ts:12`) → graph input →
`OrderProposal` (`schemas/proposal.ts`) → `CartController.applyProposal`. **Do not do this.** It
pushes `device_id`/`table_id` through the LLM graph, which has no use for them — five contract
changes across three modules to carry data the ordering module never reads.

Instead: a **new `client.connected` event** emitted by the gateway at connect, handled by the cart
module, which creates the cart with identity stamped. One new contract; identity stays in
realtime + cart.

### The multi-device question is deliberately sidestepped

There is an unresolved disagreement: the user states a cart cannot have multiple sessions/devices;
`design.md:505` says *"Multiple voice sessions (or the app UI) can edit one `cart_id` at once —
usually the same customer on two devices or a reconnect artifact"*, and `design.md:14` makes
*"Customer can edit an existing order in a later voice session"* a functional requirement (so a cart
provably outlives a session).

**This design does not need it resolved.** An index is many-to-many by nature — if two devices touch
one cart it simply appears under both device keys. `Cart.device_id` means **the device that created
the cart**, which is singular and true under both readings. Do not "resolve" this dispute as part of
this work; do not rewrite `design.md`.

## Data flow (target)

```
WS upgrade ?device_id=&table_id=  → authenticate() → AuthContext{device_id, table_id?}
  → ClientConnection             → gateway.onConnect → bus.emit('client.connected', {...})
  → CartController.ensureCart    → creates cart w/ device_id + table_id if absent (no-op if exists)
  → repo.commitApplied           → Lua: cart blob + ledger + device index + table index (atomic)

POST /v1/carts/:cart_id/confirm  → CartController.confirm(cart_id)  [apply lock]
  → already confirmed?           → return stored pos_order_id (no Odoo call)
  → repo.confirmOrder(cart)      → toInsertCartRequest(cart) → OdooClient.insertCart()
                                 → POST {ODOO_API_URL}/goopter_cart_api/v1/cart  (Bearer)
  → persist confirmed_at + pos_order_id → 200 {pos_order_id}

order.operations_proposed → CartController.applyProposal  [same apply lock]
  → cart.confirmed_at set?       → reject every op, reason 'cart_confirmed', no version bump
```

---

## Changes

### 1. `src/shared/types.ts` — add `DeviceId`

`RestaurantTableId` already exists at line 20 (unused until now). Add alongside the "Our identities"
group (it is ours, not Odoo's):

```ts
export type DeviceId = string; // stable per client device; survives reconnect (session_id does not)
```

### 2. `src/cart/cart-types.ts` — `Cart` identity + confirmation fields

```ts
export interface Cart {
  cart_id: CartId;
  pos_config_id: PosConfigId;
  /** The device that CREATED this cart. Stable across reconnects (session_id is not). */
  device_id?: DeviceId;
  /** restaurant_table.id — dine-in only. Absent = takeout/untabled (SPEC allows untabled orders). */
  table_id?: RestaurantTableId;
  version: number;
  items: CartLine[];
  subtotal_cents: Cents;
  tax_cents: Cents;
  total_cents: Cents;
  last_updated: string;
  /** Set once when the cart is inserted into Odoo. Never cleared — see the confirmation lock (§6b). */
  confirmed_at?: string; // ISO
  pos_order_id?: PosOrderId;
}
```

**Why `device_id` is optional on the type despite being conceptually total:** `emptyCart` serves two
masters. Only `cart-controller.ts:44` creates a cart that is **persisted**. The other two callers —
`load-cart.node.ts:22` and `realtime-gateway.ts:96` — build **throwaway** carts for prompt views and
snapshots that are never written and never read either field. Making it required forces threading a
dummy device through the prompt path purely to satisfy a type. **The write path guarantees it; the
type does not.** (If a future change wants the strong type, split the helper — `newCart` for the
writer, keep `emptyCart` for views — rather than threading.)

Extend `emptyCart` with an optional identity argument; keep the existing 2-arg call sites working:

```ts
export function emptyCart(
  cart_id: CartId,
  pos_config_id: PosConfigId,
  identity?: { device_id?: DeviceId; table_id?: RestaurantTableId },
): Cart
```

### 3. `src/auth/auth-types.ts` + `src/auth/session-auth.ts`

`AuthContext` gains `device_id: DeviceId` and `table_id?: RestaurantTableId`.

`authenticate()` (`session-auth.ts:10`) currently requires `session_id`/`cart_id`/`pos_config_id`.
Add `device_id` as **required** (reject with `unauthenticated` when missing — every client has one).
`table_id` is **optional** — absent means takeout/untabled, a valid state.

Note the existing docstring already says this is a stub that trusts query params, with a TODO to
verify a signed token. **That remains true and is not this plan's job** — `device_id` and `table_id`
are as unauthenticated as `cart_id` is today. Do not present this as a security boundary.

### 4. `src/realtime/`

**a. `websocket-server.ts:116` `paramsFromUrl`** — parse `device_id` (string) and `table_id`
(int, optional). Mirror the existing `pos_config_id` `parseInt` + `NaN` guard for `table_id`.

**b. `websocket-server.ts:27`** — extract the `createServer` request handler into `src/api/` (§10).
`/health` behavior must stay byte-identical.

**c. `client-registry.ts`** — `ClientConnection` gains `device_id` and `table_id?`. **The only other
change is the docstring**, which currently reads "A cart may have several sockets (multi-device /
reconnect)". Clarify *why* it is a `Set` without taking a side in the dispute:

```
/**
 * Tracks connected clients by session and cart. `byCart` is a Set because sockets on one cart can
 * overlap transiently: on reconnect the new socket is added before the old one's close fires (up to
 * heartbeatTimeoutMs / reconnectWindowMs, constants.ts). Removing by identity — rather than
 * clearing the cart key — is what keeps the live socket reachable. cart.updated broadcasts to all
 * (design §9 Tier 2, §"Concurrency on a shared cart").
 */
```

**d. `realtime-gateway.ts` `onConnect` (~line 71)** — emit the new event:

```ts
this.bus.emit('client.connected', {
  cart_id: conn.cart_id,
  pos_config_id: conn.pos_config_id,
  session_id: conn.session_id,
  device_id: conn.device_id,
  ...(conn.table_id !== undefined ? { table_id: conn.table_id } : {}),
});
```

Leave `realtime-gateway.ts:96`'s `?? emptyCart(msg.cart_id, conn.pos_config_id)` alone — that cart
is a read-only snapshot, never persisted.

### 5. `src/events/event-types.ts` — new `client.connected` event

```ts
/** A client socket authenticated and attached to a cart. The cart module uses this to create the
 *  cart with its durable identity (device, and table for dine-in) before any ordering happens —
 *  identity is not threaded through the ordering module, which has no use for it. */
export interface ClientConnected {
  cart_id: CartId;
  pos_config_id: PosConfigId;
  session_id: SessionId;
  device_id: DeviceId;
  table_id?: RestaurantTableId;
}
```

Add `'client.connected': ClientConnected;` to `AppEventMap` (line 74).

### 6. `src/cart/cart-controller.ts`

**a. `ensureCart`** — new method, bound to `client.connected` in `register-handlers.ts`:

```ts
async ensureCart(e: ClientConnected): Promise<void> {
  await this.applyLock.run(e.cart_id, async () => {
    const existing = await this.carts.get(e.cart_id);
    if (existing) return;  // Reconnect / second device: identity is set-once, never overwritten.
    const cart = emptyCart(e.cart_id, e.pos_config_id, {
      device_id: e.device_id,
      ...(e.table_id !== undefined ? { table_id: e.table_id } : {}),
    });
    await this.repo.commitCreated(cart);   // see §7b
  });
}
```

Set-once matters: under `design.md:505` a second device may join an existing cart. `device_id` means
*creator*, so an existing cart's identity is never rewritten.

**b. The confirmation lock** — in `applyProposal`, **after** the `wasProcessed` idempotency check
(`:39`) and **before** the op loop (`:50`):

```ts
if (cart.confirmed_at) {
  for (const op of proposal.operations) {
    rejected.push({ op, error: new CartRejectedError('cart_confirmed',
      'That order has already been sent to the kitchen. Please ask a server for changes.') });
  }
  await this.repo.markProcessed(proposal.request_id, 'rejected');
  return;   // NB: `rejected` is emitted outside the try — mirror the existing early-return shape.
}
```

**Ordering is load-bearing.** After idempotency so a replayed request stays a silent no-op rather
than becoming a spurious rejection; before the op loop so nothing is applied and `version` never
bumps.

**Free correctness — do not add locking.** `applyProposal` (`:32`) and `confirm` (`:113`) already
share `this.applyLock.run(cart_id, …)`. They are mutually exclusive, so there is no check-then-act
race between "is it confirmed" and "append".

`CartRejectedError.reason` is a plain `string` (`errors.ts:39`), not a union — `'cart_confirmed'`
needs no type change. Rejections flow out on the existing `cart.operation_rejected` channel, so the
customer hears something.

**c. `confirm()` — rewrite** (`:112`). Currently returns `void` and never writes. It must return the
id and persist confirmation:

```ts
async confirm(cart_id: CartId): Promise<PosOrderId> {
  return await this.applyLock.run(cart_id, async () => {
    const cart = await this.carts.get(cart_id);
    if (!cart) throw new NotFoundError(`unknown cart ${cart_id}`);
    if (cart.confirmed_at && cart.pos_order_id !== undefined) return cart.pos_order_id; // idempotent
    const pos_order_id = await this.repo.confirmOrder(cart);
    await this.carts.set({ ...cart, confirmed_at: new Date().toISOString(), pos_order_id });
    return pos_order_id;
  });
}
```

**Crash-safety note (do not "fix" this):** if the Odoo insert succeeds but the Redis write fails, the
cart is not marked confirmed and a retry re-sends. That is **safe** — SPEC § Idempotency makes the
insert idempotent via `uuid = f"{cart_id}:{line_id}"`, so a replay creates no duplicate lines ("If
nothing remains, the call is a successful no-op"). We inherit idempotency from the far side.

`KeyedAsyncLock.run` must return the callback's value — check `shared/async-lock.ts`; if it is
typed `Promise<void>`, generify it (it is our own code).

*Consider* emitting `cart.updated` after confirming so connected clients see the confirmed state.
Not required for the endpoint; decide during implementation.

### 7. `src/cart/cart-repository.ts`

**a. Extend `COMMIT_APPLIED_LUA` (`:39`) to write the indexes.** Read that constant's existing
comment first — it explains why `MULTI` was rejected (no rollback on per-command failure, so a
partial commit could persist the cart without its ledger mark). **The same hazard applies to the
indexes**: an indexed cart that does not exist, or a cart missing from its index. One script, all
or nothing.

`table_id` is optional, so pass `numkeys` 3 or 4 and let Lua see `KEYS[4]` as `nil`:

```lua
redis.call('SET', KEYS[1], ARGV[1])                 -- cart blob
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])  -- idempotency ledger mark
redis.call('SADD', KEYS[3], ARGV[4])                -- device:{device_id} -> cart_id
redis.call('EXPIRE', KEYS[3], ARGV[5])
if KEYS[4] then
  redis.call('SADD', KEYS[4], ARGV[4])              -- table:{table_id} -> cart_id
  redis.call('EXPIRE', KEYS[4], ARGV[5])
end
```

Key helpers alongside the existing `cartKey`/`reqKey`:
`deviceKey(device_id) => "device:" + device_id`, `tableKey(table_id) => "table:" + table_id`.

**Index shape — assumption, flagged for the user:** a Redis **Set** of cart_ids per key, TTL
refreshed on every write, via a new `DEVICE_INDEX_TTL_SECONDS` defaulting to `86_400` to match
`CART_IDEMPOTENCY_TTL_SECONDS`. Reasoning: with the confirmation lock a cart's life is
create → mutate → confirm → frozen, so a device/table accumulates one cart per order over time. A
Set gives history; a plain String could only answer "current cart". Consequence to accept: an active
device refreshes the TTL on its *whole* set, and an idle one's history expires all at once.
(`cart:{cart_id}` itself has **no** TTL today — pre-existing, out of scope, do not add one here.)

**b. `commitCreated(cart)`** — new method for `ensureCart`, which has no `request_id` and so cannot
use `commitApplied`. Same script minus the ledger write (or reuse with a sentinel — implementer's
call). Must still write both indexes atomically with the blob.

**c. `confirmOrder`** — replace the stub (`:78`):

```ts
async confirmOrder(cart: Cart): Promise<PosOrderId> {
  return await this.odoo.insertCart(toInsertCartRequest(cart));
}
```

`RedisCartRepository` gains an `OdooClient` constructor arg. **`InMemoryCartRepository` (`:90`)
keeps its stub** — tests must not hit Odoo.

### 8. `src/odoo/odoo-client.ts` — NEW

JSON-RPC client. `POST {ODOO_API_URL}/goopter_cart_api/v1/cart`, header
`Authorization: Bearer {ODOO_API_KEY}`.

**The one thing that must not be got wrong** (SPEC § "Found during implementation"):

> **JSON-RPC returns HTTP 200 on failure**, with the error in the body. Callers must not branch on
> the status code.

So: **branch on `body.error`, never on `res.ok`/`res.status`.** A 200 with an `error` member is a
failure. Map it to a thrown typed error (`AppError`) carrying Odoo's message.

Use `type: "jsonrpc"` semantics — the envelope is `{jsonrpc: "2.0", method: "call", params: {...}}`
and the reply is `{jsonrpc, id, result}` **or** `{jsonrpc, id, error}`.

Follow `src/menu/jina-embedding-service.ts:72` for the repo's existing pattern of a `fetch` +
bearer-header external client (timeout handling, error shape).

**Other SPEC facts worth knowing** (do not act on, just do not be surprised):
- The integration user must be an internal user *and* a POS user — `group_pos_user` alone cannot
  read `product.template.attribute.value`. A provisioning concern on the Odoo side.
- Odoo 19 requires every API key to carry an expiration date — the key will need rotating.
- A POS session in `opening_control` is **not** usable; carts are refused until the cashier confirms
  the opening cash count. Expect `no open session` errors in dev that are not our bug.

### 9. `src/odoo/cart-to-insert-request.ts` — NEW (pure, unit-testable)

Implements SPEC § "Mapping from the external service's `Cart`". Read that table.

```ts
interface RequestLine { line_id: string; product_tmpl_id: number; quantity: number; ptav_ids?: number[] }
interface InsertCartRequest {
  cart_id: string;
  pos_config_id: number;
  items: RequestLine[];
  table_id?: number | null;
  // preset_id deliberately omitted — see § Takeout
}
```

- **Dropped:** `name`, `names`, `modifiers[].name(s)` (SPEC: caller-supplied names would print
  arbitrary text on kitchen tickets; Odoo builds `full_product_name` server-side);
  `product_id` (SPEC: only sent "if known", so resolution from template+PTAVs is required anyway);
  `subtotal_cents`/`tax_cents`/`total_cents` (server-authoritative pricing);
  `version`/`last_updated` (SPEC § "Why `version`/`last_updated` are unnecessary" — strict
  append-only makes insert commutative and idempotent).
- **Flatten** `modifiers[].ptav_id` → `ptav_ids: number[]`.
- **`table_id`** present → send; absent → **omit** → untabled order.
- `line_id` is sent **raw**. The `cart_id:` namespacing into a globally-unique uuid is done **on the
  Odoo side** (SPEC § "The line uuid is the idempotency key"). Do not pre-namespace it here.

### 10. `src/api/` — routing

Extract the handler from `websocket-server.ts:27` into e.g. `src/api/http-router.ts`, keeping
`/health` byte-identical (`healthCheck()` from `health.routes.ts` is already the right seam). Add:

```
POST /v1/carts/:cart_id/confirm   → CartController.confirm(cart_id) → 200 {pos_order_id}
```

No request body. Errors: unknown cart → 404; Odoo error → 502 with the message; confirm on an
already-confirmed cart → **200 with the stored id** (idempotent, not an error).

Note our REST route returning honest HTTP status codes is *deliberately unlike* the JSON-RPC far
side (§8). That asymmetry is correct — do not propagate their 200-on-error convention.

**Auth on this endpoint is an open question** (see below) — do not invent a scheme.

### 11. `src/config/env.ts` + `.env.example`

```ts
readonly odooApiUrl: string;            // ODOO_API_URL      — base URL of the Odoo instance
readonly odooApiKey: string;            // ODOO_API_KEY      — Odoo API key of the integration user
readonly deviceIndexTtlSeconds: number; // DEVICE_INDEX_TTL_SECONDS, default 86_400
```

Follow the file's existing `str()`/`int()` + safe-default style. `ODOO_DATABASE_URL` is unrelated —
that is the Postgres/pgvector menu read path (`db/postgres-client.ts`), **not** the Odoo API.

### 12. `src/app.ts` — wiring

Construct the `OdooClient` and pass it to `RedisCartRepository` (line 64). Bind `client.connected`
in `registerCartHandlers` (line 66). The HTTP router needs the `CartController` — currently
`startWebSocketServer(gateway, config.port)` (line 83) takes only the gateway, so thread the
controller (or the router) through.

---

## Out of scope / leave alone

- **`/quote`.** Not built. Note for whoever picks it up: SPEC § "Quote/insert consistency" requires
  both routes to share **one** pricing function, and warns that core passes `qty=1.0` to
  `_get_product_price` while passing real qty to `compute_all`.
- **Pricing divergence — explicitly accepted by the user.** This repo prices carts itself
  (`base + Σ modifier price_extra) × qty`, tax is a `TODO` per `.claude/.knowledge/cart/overview.md`).
  Odoo ignores our numbers and reprices server-authoritatively (SPEC § "Never trust client prices").
  **So the total the customer hears can differ from the bill — tax alone guarantees it today.**
  Do not "fix" this here; do not send our `*_cents` to Odoo hoping they are honored (they are
  dropped by contract).
- **Do NOT** call Odoo's `recompute_prices()` or reach into the addon. SPEC § "⚠ Recompute MUST be
  scoped to our own new lines" — a wholesale recompute silently erases happy-hour discounts. That is
  the far side's concern and it already handles it.
- **Do NOT** collapse `ClientRegistry.byCart` to a single connection (see § Decided design).
- **Do NOT** rewrite `design.md:503-506` or "resolve" the multi-device question.
- **Do NOT** add a TTL to `cart:{cart_id}` — pre-existing, unrelated.
- **`preset_id`** — see below.

### Takeout: the identity model is ready, the far side is not

`table_id?` being absent makes this repo takeout-ready. **But takeout is already broken on the Odoo
side, deliberately.** SPEC § "Open questions — resolved" #2:

> every cart is treated as dine in, so the request carries no `preset_id` ... The consequence is
> accepted and documented: **a takeout cart pushed through this API at izumisushi is taxed dine-in.**

`preset_id` drives fiscal position *and* pricelist; at `pos_izumisushi` the Takeout preset carries
fiscal position 3 (Manitoba, with live tax mappings) while Dine In carries none. **The blocker for
takeout is `preset_id`, not the identity model.** Do not send `preset_id`. Do not let "we added
`table_id?`" be read as "takeout works."

## Verification

1. `npm run typecheck` (→ `tsc -p tsconfig.test.json`) — clean.
2. `npm run test` — all pass. Existing suites likely to need updating:
   - `src/cart/cart-controller.test.ts`, `cart-repository.test.ts`, `redis/cart-cache.test.ts`,
     `realtime/realtime-gateway.test.ts` — ~10 `emptyCart(...)` call sites (the optional 3rd arg
     keeps them compiling; check assertions on the cart shape).
   - `client-registry.test.ts` — `ClientConnection` gains fields; its `conn()` helper needs them.
3. New tests:
   - `cart-to-insert-request.test.ts` — drops `name`/`names`/`product_id`/`*_cents`/`version`/
     `last_updated`; flattens `ptav_id`s; omits `table_id` when absent; sends raw `line_id`.
   - `odoo-client.test.ts` — stubbed `fetch`; **HTTP 200 carrying `error` is treated as a failure**
     (the regression test for the whole feature); success returns `pos_order_id`.
   - `cart-controller.test.ts` — proposal against a confirmed cart: every op rejected with
     `cart_confirmed`, `version` **unchanged**, nothing persisted; a *replayed* request against a
     confirmed cart is still a silent no-op (idempotency wins, no rejection emitted); double-confirm
     calls Odoo **once**; `ensureCart` on an existing cart does **not** overwrite `device_id`.
   - `cart-repository.test.ts` — cart blob + ledger + device index + table index land together;
     no `table_id` → only the device index is written.
4. E2E: `npm run test:e2e` (`vitest.e2e.config.ts`). Connect with `device_id`+`table_id`, order,
   `POST /v1/carts/:cart_id/confirm`, assert `pos_order_id` and that a further proposal is rejected.
5. Manual: `GET /health` still answers (the extraction in §4b/§10 must not regress it).

## Knowledge base / docs (same commit, per CLAUDE.md)

- **`.claude/.knowledge/log.md`** — new entry at the **top** (newest first), format per CLAUDE.md
  (`## YYYY-MM-DD — <title>` + What/Why/Where/Notes).
- **`.claude/.knowledge/cart/overview.md`** — its "Not done yet" section explicitly names
  `confirmOrder` as a stub; update. Document the confirmation lock under Mechanics.
- **`.claude/.knowledge/persistence/overview.md`** — the new `device:`/`table:` index keys and their
  TTL, alongside the existing `cart:` / `cart:req:` documentation.
- **`.claude/.knowledge/realtime/overview.md`** — line 25 describes the multi-device broadcast; add
  the `client.connected` emit.
- **`.claude/.knowledge/events/overview.md`** — new `client.connected` event.
- **`.claude/.knowledge/index.md`** — add an `odoo` bundle line if `src/odoo/` becomes a module
  bundle (it should — `index.md` + `overview.md`, copying an existing bundle's frontmatter).
- **`docs/odoo-integration.md`** — currently says "On order confirmation, send the cart to the odoo
  backend to place an order / expose a odoo api" as a *proposal*. Update to reflect what exists.

## Key file/line anchors (as of this plan)

- `SPEC.md` — the far side's contract. §"Mapping from the external service's `Cart`" (~line 79) is
  the mapping table; §"Found during implementation" (~line 667) has the 200-on-error fact.
- `src/cart/cart-controller.ts:32` `applyProposal`; `:39` `wasProcessed` (lock goes right after);
  `:44` `emptyCart` fallback; `:50` op loop; `:112` `confirm`.
- `src/cart/cart-repository.ts:15` `CartRepository` interface; `:39` `COMMIT_APPLIED_LUA` (+ its
  why-not-MULTI comment); `:78` `confirmOrder` stub; `:90` `InMemoryCartRepository`.
- `src/cart/cart-types.ts:35` `Cart`; `:46` `emptyCart`.
- `src/redis/cart-cache.ts:19` `cartKey`.
- `src/shared/types.ts:20` `RestaurantTableId` (declared, unused).
- `src/auth/session-auth.ts:10` `authenticate` (stub — trusts query params).
- `src/realtime/websocket-server.ts:27` `createServer` (the only HTTP server); `:116` `paramsFromUrl`.
- `src/realtime/client-registry.ts:5` `ClientConnection`; `:19-20` the maps.
- `src/realtime/realtime-gateway.ts:71` `onConnect`; `:96` read-only `emptyCart`.
- `src/events/event-types.ts:74` `AppEventMap`.
- `src/api/health.routes.ts:8` `healthCheck` ("Wire to an HTTP server as needed").
- `src/menu/jina-embedding-service.ts:72` — existing `fetch` + bearer external-client pattern.
- `src/config/constants.ts:11,13` `heartbeatTimeoutMs` / `reconnectWindowMs` (the reconnect window).
- `docs/design.md:503-506` §"Concurrency on a shared cart"; `:1105` §17.8 contract keys → Odoo ids
  (`table → restaurant_table.id`); `:14` "edit in a later voice session".
- `goopter_pos_split_bill/tests/test_process_order.py:44-90` (**other repo**) — payload helpers, per
  SPEC § Verification.

## Open questions for the implementer — ask the user, do not guess

1. **Auth on `POST /v1/carts/:cart_id/confirm`.** SPEC covers Odoo trusting *us* (bearer + API key).
   Nothing decided about what authenticates the *frontend* to this route. `session-auth.ts` is a stub
   that trusts query params, so there is no existing scheme to copy. **Unresolved from the design
   conversation.**
2. **Index shape/TTL** (§7a) — Set + 24h TTL is an *assumption*, stated but never confirmed.
3. **`cart.updated` after confirm?** (§6c) — should connected clients be told the cart is now frozen?
   Otherwise a client discovers it only by having its next utterance rejected.
4. **Endpoint name/shape** — `POST /v1/carts/:cart_id/confirm` is proposed, not agreed.
