# Agent Search Extension — keywords, filters, popularity (spec)

Status: **implemented**. Extends the retrieval half of `docs/agent-tools.md`, which
deferred `filter_menu` and `popular_items` to "later phases" (§2 Out, §8 Later).

Sections below are written as a proposal and kept for rationale; §1's description of
`search_menu_semantic` is the *before* state. What shipped: `search_menu` with
`{query?, sort?, max_price_cents?, min_price_cents?, limit?}`, `MenuStore.popularity()`,
a coarse `CandidateItem.popularity` tier, and `MENU_EXCLUDED_CATEGORIES` applied by the
seed. Open questions §8 were resolved as: one tool (Q1), no category filter (Q2), tiers at
rank 5/20 (Q3), a 90-day window (Q4), and $0 items included (Q5 — excluding them would make
Izumi's entire AYCE menu unrecommendable).

Scope: `src/ordering/tools/`, `src/menu/` (store queries + types), `src/config/`.
No change to event contracts, the cart module, the graph shape, or the terminal
outcomes.

---

## 1. Problem

The agent has exactly one retrieval tool: `search_menu_semantic(query)` →
`menu.getCandidates()` → hybrid KNN+lexical over item *names*, hybrid-ranked,
thresholded at 0.15, capped at `LIMITS.maxCandidatesToLlm` (8).

That surface can only answer "is there an item whose **name** looks like this
phrase". It cannot answer:

| Customer says | Why it fails today |
|---|---|
| "what do you suggest?" | No popularity signal exists; nothing to rank by. The agent free-associates from an unranked name search, or replies from the prompt alone. |
| "what's popular and has fish?" | Same, plus: nothing intersects a relevance search with a ranking. |
| "anything under $10?" | `base_price_cents` is hydrated but never filterable or sortable. |

Goal: let the agent retrieve by **relevance, price, and popularity** in one
composable call, so a query with two constraints resolves in one tool round-trip.

## 2. What the data can and cannot support

This is the load-bearing section — it sets the scope, and one of the three
motivating queries is only half-answerable.

Grounded in `docs/pos-product-modifier-order-schema.md`:

**Available:**
- **Price** — `product_template.list_price`, already hydrated as
  `base_price_cents`. Free.
- **Popularity** — *derivable only*. Nothing precomputes it (§5 "There is no
  popularity data"); `product.template.sales_count` is a documented trap
  (`store = False`, computed from `sale.report`, reads **0 for every product** in
  both DBs). Must aggregate `pos_order_line`.
- **Category** — `pos_categ_ids` via `pos_category_product_template_rel`. Exists,
  but is **not currently read anywhere** — `categ_id` (hydrated by nothing) is the
  accounting category, not the menu one.

**Not available at all:**
- **Ingredients.** There is no ingredient, tag, or dietary field on
  `product_template`. **"has fish" is not a structured filter** — it resolves
  only as a *name* match ("Atlantic Salmon", "Tuna Roll") or, loosely, a category
  ("Sashimi"). An item named "Chef's Special" containing salmon is unreachable by
  any query in this spec.
- **Dietary/allergen.** No field. Jade Garden's modifiers *look* like allergen
  data ("No Peanuts", "no Ginger") but they are per-item **exclusion options**,
  not a claim that the dish contains peanuts. Inferring "contains nuts" from "has
  a No Peanuts modifier" is a plausible-looking inference that would be wrong
  often enough to matter on an allergen question. **Explicitly out of scope.**

  One caveat, so this isn't recorded as more absolute than it is: a *partial*
  vegetarian signal does exist in POS categories — Izumi has `Vegetarian Maki& roll`
  (8 items) and `Vegetarian Maki & roll - A` (6). It covers only maki/rolls, so it
  cannot answer "what's vegetarian?" for the menu as a whole, and it is a category
  convention rather than a dietary claim. Not a basis for an allergen answer; it is
  a basis for a future *category* feature (§8 Q2) if one is ever wanted.

**Consequence for "what's popular and has fish?":** it decomposes into
`semantic("fish")` ∩ `rank by popularity` — a relevance search re-ranked by
popularity. It is answered as well as the data allows, but its recall ceiling is
"items with a fishy **name**", not "items containing fish". Accept and document;
closing it needs an ingredient/tag source that does not exist today.

## 3. Scope

**In:**
- One extended retrieval tool replacing `search_menu_semantic` (§4).
- Popularity derived from `pos_order_line` (§5), exposed as a sort mode + a
  coarse tier on the candidate.
- Price filter (`max_price_cents` / `min_price_cents`) and popularity sort.
- **`MENU_EXCLUDED_CATEGORIES`, applied in the seed** (§5.3) — keeps cover charges
  out of the ranking. One config entry; needed only because qty-ranking surfaces
  them (Adult is Izumi's #2).

**Out:**
- Ingredient/dietary/allergen filtering — **no data source** (§2).
- Category filter — deferred (§8, open question 2); semantic name search already
  covers "sashimi"/"noodles" reasonably, and it needs a new join *plus* a way for
  the agent to learn the tenant's category vocabulary.
- Any change to `propose_cart`, the `reply` terminal, `order.reply`, or the graph.
- A materialized popularity rollup (§5.2 — live aggregate is fine at current
  volume).
- **The pre-existing hole that makes "Discount"/"Refund" proposable** (§5.3, end) —
  real, live, orthogonal to ranking, and its own ticket.

## 4. Tool surface

**Recommendation: extend the one existing tool rather than add `filter_menu` +
`popular_items` as separate tools** (which is what `agent-tools.md` §2 sketched).

Rationale: "popular **and** has fish" is a single intersection. Two tools force
the *agent* to fetch a relevance list and a popularity list and intersect them in
its head — a step models routinely get wrong, and one that costs an extra
`agent ⇄ tools` round-trip on a latency-critical voice path (§7). One tool with a
sort parameter makes the intersection the *server's* job, where it is a SQL
`ORDER BY`.

Rename `search_menu_semantic` → `search_menu` (it is no longer purely semantic):

```ts
{
  name: 'search_menu',
  parameters: {
    query?:          string,   // omit for a pure browse, e.g. bare "what's popular?"
    sort?:           'relevance' | 'popularity',  // default 'relevance'
    max_price_cents?: number,
    min_price_cents?: number,
    limit?:          number,   // default & hard cap LIMITS.maxCandidatesToLlm (8)
  }
}
```

Behavior by shape — note the third row is the "popular and has fish" case:

| `query` | `sort` | Path |
|---|---|---|
| set | `relevance` | Today's `getCandidates()`, unchanged. The default; no regression. |
| absent | `popularity` | **Bypasses the matcher** (no query vectors ⇒ no relevance score). Store-side: popular items for the pos, price-filtered, top N. Answers "what do you suggest?". |
| set | `popularity` | Retrieve by relevance, **re-rank by popularity**. See the over-fetch trap below. |
| absent | `relevance` | Degenerate — no ranking signal. Treat as `sort: 'popularity'` rather than returning an arbitrary 8 items. |

**The over-fetch trap (must not be got wrong).** `getCandidates()` truncates to
`maxCandidatesToLlm` (8) *before* returning. Re-sorting that 8 by popularity
yields "the 8 most fish-like items, ordered by popularity" — **not** "the most
popular fish". The two differ whenever the popular fish item ranks 9th by name
similarity, which is exactly the common case on a large menu. The relevance
retrieval must over-fetch (reuse the existing `k·4` convention) and truncate to
`limit` **after** the popularity re-rank.

`SCORE_THRESHOLD` (0.15) still applies to the relevance leg before re-ranking —
popularity re-orders relevant items, it does not admit irrelevant ones. Otherwise
"popular and has fish" degrades into "popular", silently.

## 5. Popularity

### 5.1 Derivation

Per `pos-product-modifier-order-schema.md` §5, with every documented caveat load-bearing:

```sql
SELECT pp.product_tmpl_id, sum(l.qty) AS qty_sold
FROM pos_order_line l
JOIN pos_order o        ON o.id = l.order_id           -- state + window live on the header
JOIN product_product pp ON pp.id = l.product_id        -- NOT id-equality; see below
WHERE o.state IN ('paid','done','invoiced')            -- excludes draft/cancel
  AND NOT l.is_reward_line
  AND o.date_order >= now() - ($2 || ' days')::interval
  AND EXISTS (SELECT 1 FROM item_vector iv             -- pos scoping; EXISTS, not JOIN
               WHERE iv.product_tmpl_id = pp.product_tmpl_id
                 AND iv.pos_config_id = $1)
GROUP BY pp.product_tmpl_id
ORDER BY qty_sold DESC;
```

**No exclusion list here.** Non-dishes are gated out of `item_vector` at seed time
(§5.3), so the `EXISTS` clause is the only filter needed — it does pos-scoping and
non-dish exclusion in one.

**Two joins, not three.** The schema doc's example query (§5 "Deriving
popularity") also joins `product_template`, but only because it selects
`pt.name->>'en_US'`. This query selects no template column: the join condition
`pt.id = pp.product_tmpl_id` means `pp.product_tmpl_id` *is already* the value,
so joining `product_template` would re-derive a held column through a guaranteed
FK. Names are hydrated separately via `getItems()`. Do not copy the doc's join
list without re-earning each join.

**`item_vector` is joined with `EXISTS`, never a plain `JOIN`.** It holds one row
per **(item, language)** (`lang` column, DDL at `postgres-menu-store.ts:95`) —
which is why `hydrate()` needs `DISTINCT ON (iv.product_tmpl_id)`. A plain join
fans out and multiplies `sum(l.qty)` by the language count. The inflation is
uniform, so the *ranking* still looks correct and the bug stays invisible until
someone reads a raw count — exactly the failure that survives review.

- **Rank by qty, never revenue.** Izumi is all-you-can-eat: **96 of 299 products
  (32%) are $0**, and its top seller is 89 × $0.00 salmon sashimi. Revenue
  ranking puts Izumi's most popular food *last*. This is the single biggest
  correctness trap here.
- **Join through `product_product.product_tmpl_id`.** `pos_order_line.product_id`
  is *not* the template id, but it coincidentally matches **61% in Izumi vs 9% in
  Jade** — shortcut code passes Izumi tests and breaks on Jade Garden.
- Refunds net out on their own (negative `qty`).
- `report_pos_order` is a plain view over the same lines — no perf advantage, no
  reason to use it.

The `item_vector` `EXISTS` clause is the single gate: it scopes to `pos_config_id`
(Odoo's `available_in_pos` is global) **and** carries the non-dish exclusion,
because membership is decided at seed time (§5.3).

### 5.2 Freshness & cost

Live aggregate per call, no cache. At current volume (1,268 / 1,018 lines) this
is trivial, and it matches the menu module's existing "every request reads the
store at query time — there is no in-memory menu cache" stance. Revisit if line
count grows by ~100×; the fix is then a rollup table, not a process cache (the
service is multi-instance).

**Date coverage is thin** — Jade `2026-06-14 → 2026-07-15` (~1 month), Izumi
`2026-05-29 → 2026-07-15` (~7 weeks). A 90-day window is therefore "all of it"
today; the parameter exists so the window doesn't silently become "all time" once
years of trade accumulate. With ~1 month of data the tail is noise, so only a
coarse tier is exposed (§5.4), not a rank number.

### 5.3 Keeping cover charges out of the ranking

Ranking by qty surfaces whatever *sells*, and a cover charge sells constantly. The
fix is one config entry; the scope below is deliberately narrow, and the data says
that is enough.

**What actually contaminates a ranking** (live, both DBs, `state IN
('paid','done','invoiced')`, reward lines excluded):

| DB | rank | product | qty | handled by |
|---|---|---|---|---|
| Izumi | **2** | Adult | 54 | `CUSTOMER TYPE` |
| Izumi | 8 | Tips | 26 | already excluded — `available_in_pos = false`, so the seed never writes it |
| Izumi | 31 | Ext | 7 | `CUSTOMER TYPE` |
| Izumi | 45 | Customer 4-12 | 6 | `CUSTOMER TYPE` |
| Izumi | 198 | Refund | **−1.00** | cannot rank — see below |
| Jade | 2 | Tips | 43 | already excluded |
| Jade | — | *(nothing else)* | | **Jade needs no config at all** |

So: **exclude POS categories by name.** `MENU_EXCLUDED_CATEGORIES="CUSTOMER TYPE"`
covers every contaminant at Izumi; Jade sets nothing. Izumi's `CUSTOMER TYPE`
(pos_category 46) is 5-of-5 non-dishes (Adult, Customer 4-12, Customer under 4,
Ext, and a −$1.00 Discount product), so one legible entry — findable in the POS UI,
unlike `1313` — replaces five opaque ids and auto-covers cover types added later.

Applied in the **seed**, so `item_vector` membership is the single gate and the
runtime popularity query needs no exclusion clause (§5.1). Changing the list means
a reseed (`npm run seed:menu:pg`, needs a real embedder) — fine, since the list
changes about never and the menu is reseeded when it changes anyway.

The category relation is an m2m (`pos_category_product_template_rel`) and an item
may hold several categories (tmpl 1293 is in both `SASHIMI - A` and `Jerry-item`),
so match with `IN (SELECT …)` — never a plain join, or the seed's product list fans
out.

**Why `Refund` needs no handling:** refund lines carry negative `qty`, so the Refund
product nets to **−1.00 at rank 198**. It is structurally incapable of reaching a
top-N list. Not luck — a consequence of how refunds are recorded.

Rejected alternatives, recorded so they are not re-derived:

- **`product_template.type`** — no signal whatsoever. Verified: "Adult" and "Tips"
  are both `consu`, identical to every dish.
- **`pos_config`'s service-product refs** (`tip_product_id`,
  `down_payment_product_id`, `goopter_refund_product_id`) — looks authoritative,
  delivers nothing. `tip_product_id` → Tips, already excluded by
  `available_in_pos`; `down_payment_product_id` is null in both DBs; the only ref
  with any reach is `goopter_refund_product_id` → Refund, which cannot rank anyway.
  Reading them would also mean depending on **addon-conditional columns** that do
  not exist on every DB.
- **Template-id lists** (`…=1206,1207,…`) — five opaque per-DB ids, silent when
  wrong, needing an update whenever the menu changes.

**Out of scope — a real, separate bug.** The seed
(`populate-postgres-menu.ts:71`) writes `item_vector` from a bare
`WHERE available_in_pos AND active`, so **"Discount" (Izumi 1308, Jade 3796,
`list_price = −1.00`) and "Refund" (Izumi 1307, Jade 32) are searchable and
`propose_cart`-able today** — a customer saying "discount" can add a negative-price
line. Neither ranks, so neither affects this feature; the category exclusion
happens to fix Izumi's Discount as a side effect but leaves Jade's (uncategorised).
That is a pre-existing `propose_cart` hole and wants its own ticket, not this one.

**Decided:** cover charges are staff-entered at table seating, not voice-ordered,
so dropping them from `item_vector` is safe.

### 5.4 Exposure to the agent

Add to `CandidateItem`:

```ts
popularity?: 'top' | 'popular' | undefined;   // coarse tier; absent = unremarkable
```

**Not a raw count and not a rank.** "Our #3 item, 47 sold" is a strange thing for
a restaurant to say aloud, and on ~1 month of data the precision is fake. A tier
the agent can voice as "one of our most popular" is honest at this sample size.
Tier boundaries (e.g. top 5 / top 20 of the ranked non-excluded set) are an open
question.

## 6. Non-goals worth stating

- **Not** a general menu Q&A surface. No nutrition, no ingredients, no "is this
  gluten free" — §2.
- **Not** a personalization or order-history feature. Popularity is
  restaurant-wide, not per-customer; `partner_id` is out of scope.

## 7. Risks

- **Latency.** The voice path is already multi-round-trip and
  `LIMITS.maxAgentSteps` is **8** in code (`constants.ts:27`) — note
  `agent-tools.md` §6/§9 still says 4; the doc is stale. One composable tool keeps
  the common two-constraint query at one round-trip; two tools would make it two.
- **Popularity is a feedback loop.** Recommending the popular makes it more
  popular. Real, unmitigated, probably acceptable — but it means the tier will
  ossify over months.
- **Thin data.** ~1 month; a one-off catering order can distort a rank. Mitigated
  by exposing tiers, not ranks (§5.4).
- **Sort default.** `sort` defaulting to `relevance` keeps today's behavior exactly
  when the agent omits it — the migration is a rename plus additive params, so a
  model that ignores the new params behaves as it does now.

## 8. Open questions

1. **One tool or three?** (§4) I recommend one `search_menu`; `agent-tools.md`
   sketched `filter_menu` + `popular_items`. Recommending against the earlier
   sketch, so worth an explicit yes/no before coding.
2. ~~**Category filter in or out?**~~ **Resolved: out.** Semantic name search
   covers most category-ish asks, and a category filter would need the agent to
   learn each tenant's category vocabulary (a tenant-dynamic prompt, which it
   currently isn't). Not in this change.
3. **Popularity tier boundaries** — top-5/top-20? Percentile? Per-category or
   menu-wide? (Menu-wide favours whatever category sells most; per-category is
   fairer but needs Q2 resolved first.)
4. **Popularity window** — 90 days proposed, which is currently "everything".
   Confirm, or make it config.
5. **Should `sort: 'popularity'` with no query filter out unavailable items only,
   or also $0 items?** Izumi's $0 AYCE items are real, orderable dishes and
   *should* be recommendable — but a $0 item surfacing at Jade Garden probably
   signals a data error, not a freebie. Tenant-dependent; needs a call.

## 9. Verification

Per `CLAUDE.md` §4 (goal-driven), the criteria before coding:

- `search_menu({query:'chicken'})` returns today's result set unchanged —
  characterization test on the existing behavior first, to prove the rename +
  additive params are not a regression.
- `search_menu({sort:'popularity'})` on a seeded fixture returns items ordered by
  summed qty, **excluding** a draft order's lines, a reward line, a configured
  tip/cover product, and netting a refund's negative qty.
- **The Jade-vs-Izumi join bug is pinned explicitly:** a fixture where
  `product_id ≠ product_tmpl_id` returns the *correct* template. (Id-equality
  code passes an Izumi-shaped fixture — the test must be Jade-shaped.)
- **The over-fetch trap is pinned:** a fixture where the most popular matching
  item ranks 9th by relevance still surfaces in `{query, sort:'popularity'}`.
- Revenue-vs-qty: a fixture with a $0 high-qty item and a high-price low-qty item
  ranks the $0 item first.
- End-to-end via the agent graph (scripted `StubLlmProvider`): "what's popular and
  has fish?" ends in a `reply` naming a fish item, in one search call.

## 10. Knowledge-base updates (on implementation)

Per repo convention: update `.claude/.knowledge/menu/overview.md` (new store
queries, popularity derivation, `CandidateItem.popularity`) and
`.claude/.knowledge/ordering/overview.md` (tool set), and append a `log.md`
entry. Also fix `docs/agent-tools.md` §2/§8 (deferred items now landed) and its
stale `maxAgentSteps = 4` (§7 above).
