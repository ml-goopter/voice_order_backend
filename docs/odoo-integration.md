## Odoo Integration
## Data sync
### Why
- Avaliability and price of items may change through out the day
- Redis needs updated avaliabillity and prices
### Proposal
- a sync hook 
    - Odoo save an item to a queue on write if avalibility or price or other data changes
    - We let a worker polls that queue
```
Every few seconds:
    read pending sync jobs from Odoo
    fetch latest product data
    update Redis
    mark job done
```

## POS integration

**Built.** On order confirmation we send the cart to Odoo, which places the order. The
Odoo side is the **`goopter_cart_api` addon**, which is already implemented and lives in a
**different repo** — `SPEC.md` (repo root) is its contract. We code against it; we do not
reimplement it.

```
POST /v1/carts/:cart_id/confirm        (our REST route — no body)
  → CartController.confirm(cart_id)    [apply lock]
  → already confirmed? → return the stored pos_order_id, no Odoo call
  → toInsertCartRequest(cart) → OdooClient.insertCart()
  → POST {ODOO_API_URL}/goopter_cart_api/v1/cart   (Authorization: Bearer {ODOO_API_KEY})
  → persist confirmed_at + pos_order_id → 200 (empty body)
```

The API is **strictly append-only**: it inserts lines, never modifies or removes them.
Idempotency comes from the far side, which namespaces each line uuid as
`{cart_id}:{line_id}` — so a replayed cart creates no duplicate lines, and we inherit that
rather than implementing our own.

Once confirmed, a cart is **frozen** (the confirmation lock): every further operation is
rejected with `cart_confirmed`. The frontend clears its cart view on the 200.

See the [odoo](../.claude/.knowledge/odoo/overview.md) knowledge bundle for the mapping
table and the JSON-RPC 200-on-error trap.

### Risks
- if avaliabillity changes when customer is mid flow -> cart_controller catches it -> throw
- **Price divergence is real today, and accepted.** We price the cart ourselves
  (`(base + Σ modifier price_extra) × qty`, **tax is still a TODO**); Odoo reprices
  server-authoritatively and drops our numbers by contract (SPEC § Never trust client
  prices). So the total the customer *hears* can differ from the bill — tax alone
  guarantees it. The original mitigation below assumed a quote call that does not exist:
  - ~~If price changes when customer already added items to cart -> call odoo pos at order
    confirmation -> real price still show up before customer confirm~~ — `/quote` is **not
    built**. Nothing shows the customer an Odoo-authoritative price before they confirm.
- **Takeout is taxed as dine-in.** The far side treats every cart as dine-in and takes no
  `preset_id`, which drives both fiscal position and pricelist (SPEC § Open questions —
  resolved #2). Our `table_id?` being optional makes *this* side takeout-ready; the blocker
  is `preset_id` on the far side, not our identity model.

## Future features
- Let llm request water/napkins items of this nature via a odoo addon
- Text to speech so it feels more "alive" and interactive
- 

