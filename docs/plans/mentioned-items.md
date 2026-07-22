# Mentioned items on `order.reply` (plan)

Status: **implemented**. Scope: `src/ordering/`, `src/llm/agent-prompt-builder.ts`, `src/contracts/`,
`src/events/event-types.ts`, `src/realtime/`, `src/config/constants.ts`.

## 1. Problem

When the agent recommends or names menu items ("you might also like the Chicken Burger or the
Beef Jerky"), that information reaches the customer as **speech only**. `order.reply` carries
`{reply, language}` — no structured items — so the app cannot show cards, prices, or an
add-to-cart affordance for what was just said. The items exist in the turn's `search_menu`
results, but those live in the turn-scoped scratchpad and are discarded at `finalize`.

Goal: the agent declares **which menu items its reply mentioned**, the graph **verifies those
keys against what the menu actually returned this turn**, and the verified items ride along on
`order.reply` to the client.

## 2. Design decisions

**One reply shape, one parser, one name.** The agent can speak two ways — a standalone reply (no
tool call) and a `reply` bundled into `propose_cart` — and today those are parsed by two different
code paths that happen to agree on the field names. Adding a third field to both would double that
drift risk, so this plan **unifies them first**: a single `AgentReply` shape
(`{reply, language, mentioned_items}`) and a single `parseAgentReply()` that both terminals call.
The name `mentioned_items` is then used at every hop — tool argument, spoken JSON field, graph
channel, `GraphTurnResult`, event payload, WebSocket frame — so the thing is greppable end to end
and never renamed in flight.

**The agent declares keys; the server echoes the data.** `mentioned_items` is an array of
`menu_item_key` strings — never names or prices. Every field the client sees is echoed from the
`search_menu` result the agent was shown, so the menu stays the source of truth and the model
cannot mis-state a price it just read. (Same candidate-echo rule the removed `suggest_items` tool
used — `docs/agent-tools.md` §3.2.)

**"Exists" means "the agent actually retrieved it this turn."** A key is resolved against a
turn-scoped map of every item returned by this turn's `search_menu` calls. An unresolved key is
**dropped and warned**, never looked up as a fallback. A DB fallback would launder a key the agent
invented or remembered from an earlier turn into a mentioned item; the prompt already requires
re-searching each turn (`agent-prompt-builder`, CONTEXT RULES), so an unsearched key is exactly the
hallucination signal we want to catch. Dropping degrades to today's behavior (spoken reply, no
cards), which is safe.

**Mentioned items ride on `order.reply` only.** No new event. They are meaningless without the
reply that named them, so a terminal that supplies keys but no `reply` drops the keys (debug log).
That rule lives in the shared parser, so it holds identically for both terminals.

**Not recorded to history.** `HistoryTurn` is unchanged. Cross-turn history stays compact and the
"re-search before you reuse a key" rule stays true (`docs/agent-tools.md` §5).

## 3. Wire shape

New neutral contract, `src/contracts/mentioned-item.ts`:

```ts
/** A menu item the agent named in its spoken reply, echoed from the search result it was shown. */
export interface MentionedItem {
  menu_item_key: string;
  product_tmpl_id: ProductTmplId;   // the client's handle for images / item detail from Odoo
  name: string;                     // display name as searched (en_US-first)
  base_price_cents: Cents;          // per unit, before modifiers
  popularity?: PopularityTier;      // only present on popularity-sorted searches
}
```

Deliberately omitted: `available_modifiers` (a spoken suggestion is not a configurator; adding it
would roughly triple the payload), `names`, `score`, `matched_text`. If the app later needs an
inline "add with options" flow, `available_modifiers` is the one field to add — it is already on
`CandidateItem`, so it is a projection change only.

`PopularityTier` currently lives in `src/menu/menu-types.ts`. Move the type (not the search types)
into `contracts/mentioned-item.ts` and re-export from `menu-types.ts`, so `contracts` does not
import from `menu`.

## 4. Changes

### 4.1 The unified reply (`src/ordering/graph/parse-agent-reply.ts`)

Rename `parse-spoken-reply.ts` → `parse-agent-reply.ts` and give it one shape both terminals share:

```ts
/** What the agent said this turn. IDENTICAL in both terminals: the standalone reply message and
 *  the fields bundled into `propose_cart`. `reply` is null when it said nothing usable — then
 *  `mentioned_items` is always empty, since items without a reply have nothing to accompany. */
export interface AgentReply {
  reply: string | null;
  language?: LangCode;
  mentioned_items: string[];   // raw keys as declared; verified in §4.3
}

/** Parse the reply fields off a plain object — `propose_cart` arguments, or the parsed spoken
 *  JSON. The single place the per-field degrade rules live. */
export function parseAgentReply(obj: Record<string, unknown>): AgentReply

/** The spoken terminal: unwrap the assistant text (code fence, prose around the outermost {…}),
 *  then delegate to `parseAgentReply`. Non-JSON text is still spoken as-is with no language and
 *  no items. */
export function parseSpokenReply(raw: string | undefined): AgentReply
```

Degrade rules, now stated once instead of twice:

| Field | Rule |
|---|---|
| `reply` | non-string or blank → `null` (the turn has nothing to speak) |
| `language` | `normalizeLangCode`; off-format ("Chinese") → absent, caller falls back to `TTS_LANGUAGE` |
| `mentioned_items` | non-array → `[]`; non-string/blank entries dropped; forced to `[]` when `reply` is `null` |

`normalizeLangCode` and the existing text-unwrapping behavior are unchanged.

### 4.2 Agent surface (`src/ordering/tools/tool-specs.ts`, `src/llm/agent-prompt-builder.ts`)

Both terminals gain the **same** optional field under the **same** name:

- `propose_cart` parameters: `mentioned_items: string[]` (alongside its existing `reply` /
  `language`).
- The standalone spoken terminal's JSON:
  `{"language": "...", "reply": "...", "mentioned_items": ["<menu_item_key>", ...]}` — the new
  field goes **after** `reply`. Placing it last is deliberate, and is the mirror of the
  `language`-first rule: `language` is a decision made before writing, `mentioned_items` is a
  report of what was just written.
- Prompt: one MENTIONED ITEMS section covering both terminals in the same words — "the
  `menu_item_key` of every menu item your `reply` names, in the order you name them; only keys from
  THIS turn's `search_menu` results; keys only, never names or prices; omit when the reply names no
  items."

### 4.3 Verification (`src/ordering/mentioned-items.ts`, new)

```ts
export function toMentionedItem(c: CandidateItem): MentionedItem
export function resolveMentionedItems(
  keys: string[], known: Record<string, MentionedItem>, ctx: LogCtx,
): MentionedItem[]
```

One place for the verification rules, shared by both terminals: dedupe preserving first mention;
an unknown key is dropped with one `logger.warn('order.mentioned_item_unresolved', { key,
request_id, cart_id })`; the result is capped at `LIMITS.maxMentionedItems` (new constant, `= 8`)
— a payload/card-count guard, NOT a function of `maxCandidatesToLlm`: a turn accumulates every
search it ran, so the agent may legitimately have seen more items than one search returns.
Shape-level junk is already gone — `parseAgentReply` hands it a
`string[]`.

### 4.4 Turn state (`src/ordering/graph/state.ts`)

Two new turn-scoped `lww` channels, both cleared by `normalize` (per §5's "anything not cleared
leaks into the next turn"):

- `search_results: Record<string, MentionedItem>` — every item this turn's searches returned, keyed
  by `menu_item_key`, last write wins. Stores the **projection**, not the full `CandidateItem`, so
  the checkpoint stays small.
- `mentioned_items: MentionedItem[]` — the verified items for this turn's reply. Same name as the
  raw field it came from; the type says which stage you are at.

### 4.5 Both terminals

- `run-tools.ts`, `search_menu` branch: return `search_results` (the projected map) alongside
  `content`; `runTools` merges each call's map into the accumulated state patch.
- `run-tools.ts`, `propose_cart` branch: replace the hand-rolled `reply`/`language` extraction with
  `parseAgentReply(argsObj)`, then `resolveMentionedItems` against the accumulated map **including
  this batch's searches**. Unresolvable keys never fail the tool call — the proposal still commits.
  The `order.agent_tool` log line gains `mentioned_items: n` (the count only).
- `build-graph.ts`, `agent` node: `parseSpokenReply(res.text)` now also yields `mentioned_items`;
  resolve them against `s.search_results` and write the channel. Otherwise unchanged.

After this, the two terminals differ only in *where the object comes from* (tool arguments vs.
parsed message text) — every rule about what a reply is lives in one file.

### 4.6 Façade + events

- `order-graph.ts`: `InvokeReturn.mentioned_items`; both `GraphTurnResult` variants that carry a
  reply gain `mentioned_items?: MentionedItem[]`, set only when the list is non-empty.
- `order-understanding-service.ts`: `speak()` takes them and puts them on the event — it stays the
  only `order.reply` emitter, so both paths get identical treatment.
- `event-types.ts`: `OrderReply.mentioned_items?: MentionedItem[]`.
- `realtime-message-types.ts`: `OrderReplyMsg.mentioned_items?: MentionedItem[]`;
  `realtime-gateway.ts` relays it. TTS is untouched — it speaks `reply` and never sees items.

Both fields are optional, so an existing client keeps working unchanged.

## 5. Implementation plan

Seven commits, in order. Each is independently green — `npm run typecheck && npm test` passes at
every commit boundary, and no commit leaves a half-wired field behind. Commit 1 is a pure refactor
with no new behavior, so a regression it causes is unambiguous; the field itself lands in 4–6.

Per-commit loop (global CLAUDE.md):

1. **Implement** the chunk (Sonnet subagent for the multi-file ones, Haiku for the mechanical
   ones), changing only the files listed.
2. **Verify** with the chunk's command — objective, not "looks right".
3. **Review adversarially**: fresh-context Opus subagent, prompt verbatim — *"Assume something is
   wrong with the changes. Find every issue you can and report them."* Required for commits 1, 4,
   and 5 (the parser unification, the verification path, and the wire contract); optional for the
   rest.
4. **Iterate** until the review returns nothing.
5. **Commit** the chunk with the message below.

Subagents are spawned only on your explicit go-ahead, not automatically.

### Commit 1 — `refactor(ordering): unify the two reply-parsing paths`

Behavior-preserving. No new field yet.

- `src/ordering/graph/parse-spoken-reply.ts` → `parse-agent-reply.ts`: add the `AgentReply`
  interface and `parseAgentReply(obj)`; reduce `parseSpokenReply(raw)` to text-unwrapping (fence,
  outermost `{…}`, non-JSON → speak as-is) + delegation. `normalizeLangCode` stays exported here.
- `src/ordering/tools/run-tools.ts`: the `propose_cart` branch calls `parseAgentReply(argsObj)`
  instead of hand-extracting `reply`/`language`. `ToolExecResult.reply`/`reply_language` unchanged.
- `src/ordering/graph/build-graph.ts`: import path only.
- Rename `parse-spoken-reply.test.ts` → `parse-agent-reply.test.ts`; **do not** change a single
  assertion — the whole point is that they still pass.

**Verify:** `npm run typecheck && npm test`. Every pre-existing reply/language test green with its
assertions untouched. A `git diff --stat` shows no test expectation edited.

### Commit 2 — `feat(contracts): add MentionedItem`

- `src/contracts/mentioned-item.ts` (new): `MentionedItem` + `PopularityTier` moved here.
- `src/menu/menu-types.ts`: re-export `PopularityTier` from contracts (keeps every existing import
  working; `contracts` must not import from `menu`).
- `src/config/constants.ts`: `LIMITS.maxMentionedItems = 8`, with the one-line why (a payload /
  card-count guard on what one reply ships to the client).

**Verify:** `npm run typecheck` clean with zero import churn outside these three files.

### Commit 3 — `feat(ordering): record this turn's search results`

- `src/ordering/mentioned-items.ts` (new): `toMentionedItem(c: CandidateItem)`.
- `src/ordering/graph/state.ts`: `search_results` channel (`Record<string, MentionedItem>`, `lww`).
- `src/ordering/graph/build-graph.ts`: `normalize` clears it.
- `src/ordering/tools/run-tools.ts`: the `search_menu` branch projects its items into the map;
  `runTools` merges each call's map into the returned patch.

**Verify:** `npm test src/ordering`. New cases: two searches in one turn accumulate (later key wins
on collision); `normalize` empties the map, asserted by driving turn 2 after a turn 1 that filled it
— the cross-turn leak this repo has been bitten by before.

### Commit 4 — `feat(ordering): verify and carry mentioned_items`

The core. Both terminals, one rule set.

- `src/ordering/mentioned-items.ts`: `resolveMentionedItems(keys, known, ctx)` — dedupe preserving
  first mention, drop unknown with `logger.warn('order.mentioned_item_unresolved', …)`, cap at
  `LIMITS.maxMentionedItems`.
- `src/ordering/graph/parse-agent-reply.ts`: `AgentReply.mentioned_items` — non-array → `[]`,
  non-string/blank entries dropped, forced `[]` when `reply` is `null`.
- `src/ordering/graph/state.ts`: `mentioned_items` channel (`MentionedItem[]`), cleared by
  `normalize`.
- `src/ordering/tools/run-tools.ts`: propose branch resolves against the map **including this
  batch's own searches**; unresolvable keys never fail the call. `order.agent_tool` logs the count.
- `src/ordering/graph/build-graph.ts`: the `agent` node resolves the spoken terminal's keys against
  `s.search_results`.
- Tests: `mentioned-items.test.ts` (new) — dedupe, order preserved, unknown dropped + warned, cap at
  8. `parse-agent-reply.test.ts` — parsed; `"burger"` and `[1, ""]` degrade to `[]` without touching
  `reply`; a blob with no usable `reply` yields `[]`. `run-tools.test.ts` —
  `[known, unknown, known]` → exactly one item; the same call with no `reply` → none.

**Verify:** `npm run typecheck && npm test`. Plus, explicitly: a `propose_cart` naming a key that
was never searched still commits its operations (the drop is a warn, never a tool error).

### Commit 5 — `feat(events,realtime): bundle mentioned_items on order.reply`

- `src/ordering/order-graph.ts`: `InvokeReturn.mentioned_items`; both reply-carrying
  `GraphTurnResult` variants gain `mentioned_items?`, set only when non-empty.
- `src/ordering/order-understanding-service.ts`: `speak()` takes them and puts them on the event —
  still the only `order.reply` emitter.
- `src/events/event-types.ts`: `OrderReply.mentioned_items?: MentionedItem[]`.
- `src/realtime/realtime-message-types.ts` + `realtime-gateway.ts`: same optional field, relayed.

**Verify:** `npm test`. `order-understanding-service.test.ts` asserts the field on BOTH paths
(standalone reply, bundled `propose_cart`) and its absence when empty;
`realtime-gateway.test.ts` asserts the frame carries it; a TTS test asserts `tts.speak` still
receives only `reply`/`language`.

### Commit 6 — `feat(llm): prompt the agent to declare mentioned_items`

- `src/llm/agent-prompt-builder.ts`: one MENTIONED ITEMS section written once and applying to both
  terminals; the spoken-JSON example becomes three fields in order `language`, `reply`,
  `mentioned_items`.
- `src/ordering/tools/tool-specs.ts`: `mentioned_items` on `propose_cart`, description matching the
  prompt's wording.
- `agent-prompt-builder.test.ts`: assert the rule and the three-field example are present.

**Verify:** `npm run typecheck && npm test` (full suite green — this is the last code commit).

### Commit 7 — `docs(ordering): mentioned items on order.reply`

- `docs/agent-tools.md`: revision note + §3 terminal table and §5 state table updated.
- `.claude/.knowledge/{ordering,llm,contracts,realtime}/overview.md`; append `log.md`.
- `CLAUDE.md` ordering section: one line — a reply may carry verified `mentioned_items`.

**Verify:** the knowledge-base-maintenance skill's checks; no source file in the diff.

## 6. Risks

- **The model omits `mentioned_items`.** Then the reply is spoken with no cards — today's behavior.
  Prompt-only mitigation; no retry, since a missing list is not a validation failure.
- **The model lists items it did not actually name** (e.g. every search result). Harmless to the
  cart, but the client would show more cards than were spoken. Accepted for v1; the
  `order.agent_tool` count makes it observable if it happens.
- **Payload growth on the socket.** Capped at 8 lean items (~8 × ~120 B).
