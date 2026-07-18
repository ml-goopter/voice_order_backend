# Order Understanding — LangGraph Internals

A deep reference for the `@langchain/langgraph` graph that turns a final transcript into
proposed cart operations or a spoken reply. Covers the graph topology, every state channel,
the agent ⇄ tools loop, the checkpointer thread model, and error handling.

Scope: `src/ordering/graph/` (`build-graph.ts`, `state.ts`, `intents.ts`, `instrument.ts`,
`parse-spoken-reply.ts`), `src/ordering/order-graph.ts` (the façade), `src/ordering/tools/`
(the agent's tools), and the `src/ordering/nodes/*` invoked by the graph. The service loop that
*drives* the graph (`order-understanding-service.ts`) is covered only where it touches graph
behavior — see `ordering/overview.md` for the surrounding module. The design rationale for the
agent rework lives in `docs/agent-tools.md`; this doc describes the code as it stands.

---

## 1. Where the graph sits

```
stt.final_transcript.received
        │
        ▼
OrderUnderstandingService.handleFinalTranscript
        │  (Tier-1 per-cart FIFO — CartTurnQueue serializes turns per cart_id)
        ▼
OrderGraph.start()  ──►  graph.invoke(input, threadConfig)
        │                         │
        │                         ▼
        │              ┌──────────────────────┐
        │              │ LangGraph StateGraph │  ← this document
        │              └──────────────────────┘
        ▼
GraphTurnResult: { status: 'complete', output, base_version }
             or  { status: 'reply', reply, language? }
             or  { status: 'junk' }
             or  { status: 'fail', reason }
```

The graph is a **pure proposer**. It never mutates the cart; it reads the cart snapshot, lets
the agent search the menu and decide, and returns either operations or words. Business
validation (does the key exist, is the item available) is the Cart Validator's job downstream.

---

## 2. Graph topology

Defined in `graph/build-graph.ts` → `buildOrderGraph({ menu, llm, intentLlm, carts })`.

```
 START
   │
   ▼
 normalize
   │
   ▼
 classify ──(INTENT_ROUTE, one conditional edge)──┐
   │ service                                      │ junk
   ▼                                              ▼
 load_cart                                       END   (junk not recorded)
   │
   ▼
 agent ◄─────────────┐
   │ │               │ (no terminal written)
   │ │ tool_calls    │
   │ └──► tools ─────┘
   │        │
   │        │ output set (propose_cart validated)
   │        ▼
   └──►  finalize ──► END
     (reply / failure_reason)
```

- **`normalize` is the entry point**; **`classify` runs right after it** and labels the
  NORMALIZED utterance `service | junk`, routing via a single conditional edge whose path map is
  `INTENT_ROUTE` (`graph/intents.ts`). The router returns `s.intent`; `INTENT_ROUTE` maps it to
  the next node, so routing and the intent set can't drift.
  - `service` → `load_cart` → the agent loop.
  - `junk` → `END` directly.
- **`classify` is a binary junk-gate and nothing more.** The intent set is `service | junk`
  because that is the only distinction anything downstream acts on: the agent works out what the
  customer actually wants (order / recommendation / menu answer) from the utterance itself, so a
  finer label would be read by no one. `service` covers ordering, changing or removing items,
  recommendations, and menu questions.
- **`agent ⇄ tools` is the loop** (§5). The agent searches the menu, then ends the turn either by
  calling `propose_cart` (structured operations, optionally bundling a spoken confirmation) or by
  speaking (no tool call). There is no pause/interrupt: a spoken reply is fire-and-forget.
- `finalize → END` records the completed turn to history. Every route that ran the agent passes
  through it; **`junk` skips it and goes straight to `END`**, so a non-orderable utterance
  (greeting, noise) is never recorded and can't pollute the context later fed to the agent.
- **Extensibility:** adding an intent is a one-row edit — a value in `intentSchema` and a row in
  `INTENT_ROUTE` (+ a handler node only if it needs its own behavior).

Compiled with `.compile({ checkpointer: new MemorySaver() })` — the checkpointer is what carries
`history` across turns on the same thread (§6).

### The `node()` wrapper

Every node is wrapped by `graph/instrument.ts` → `node(name, fn)`:

- Runs `fn(state)`; on throw, logs `order.node_failed` **once** with `{ node, request_id,
  cart_id, pos_config_id, ...errorMeta }`, then re-throws unchanged.
- Uses `isGraphBubbleUp(error)` to pass LangGraph's own control-flow throws (`Command` bubbling)
  straight through **without** logging them as errors.
- This centralizes per-node error attribution so a Redis failure in `load_cart` isn't mislabeled
  as an agent failure by the single catch in the service.

---

## 3. State channels (`graph/state.ts`)

State is an `Annotation.Root`. Two reducer strategies are used:

### `lww` — last-write-wins with a default

```ts
function lww<T>(def: () => T) {
  return Annotation<T>({ reducer: (_prev, next) => next, default: def });
}
```

A node returning the channel overwrites it; a node that doesn't touch it leaves the prior value.
The `default` lets a channel be *read* before it's ever written.

### `appendHistory` — accumulating, capped

```ts
reducer: (prev, next) => mergeHistory(prev, next, LIMITS.maxHistoryTurns)
```

`mergeHistory(prev, next, cap) = [...prev, ...next].slice(-cap)` — appends the completed turn(s)
and keeps only the newest `cap` (currently `LIMITS.maxHistoryTurns = 6`), oldest→newest.
Extracted as a pure function so its semantics are unit-testable without LangGraph (LangGraph
requires reducers to be pure + deterministic).

### Channel table

| Channel | Reducer | Default | Written by | Purpose |
|---|---|---|---|---|
| `request_id` | plain | — | invoke input | turn correlation id |
| `session_id` | plain | — | invoke input | voice session id |
| `cart_id` | plain | — | invoke input | cart being ordered against |
| `pos_config_id` | plain | — | invoke input | POS/menu scope |
| `customer_text` | plain | — | invoke input, then `normalize` | the utterance |
| `supported_languages` | lww | `[]` | invoke input | **currently dead** — always `[]`, never read (§6.3) |
| `intent` | lww | `'service'` | `classify` | routing label (`service`/`junk`) |
| `cart_view` | lww | `null` | `load_cart` | self-describing cart projection for the prompt |
| `base_version` | lww | `0` | `load_cart` | cart version the proposal is computed against |
| `history` | append (capped) | `[]` | `finalize` | prior turns, resent for reference resolution |
| `output` | lww | `null` | `tools` (`propose_cart`), `normalize` (clear) | the validated operations — a terminal |
| `reply` | lww | `null` | `agent` (spoken), `tools` (bundled into `propose_cart`), `normalize` (clear) | the spoken message — a standalone terminal OR a confirmation alongside `output` |
| `reply_language` | lww | `undefined` | `agent`, `tools`, `normalize` (clear) | ISO code the agent declared it wrote `reply` in |
| `agent_messages` | lww | `[]` | `agent`, `tools`, `normalize` (clear) | the turn's tool-calling scratchpad |
| `agent_steps` | lww | `0` | `agent`, `normalize` (clear) | agent LLM turns so far; guards `maxAgentSteps` |
| `failure_reason` | lww | `undefined` | `agent`, `normalize` (clear) | set when the loop ends with no terminal |

Two lifetimes are in play:

1. **Durable across turns** (survive many invokes on the same thread): `history`, plus the input
   ids. Carried by the checkpointer thread.
2. **Per-turn**: everything else. `cart_view`/`base_version`/`intent` are recomputed each turn by
   their nodes; the terminals (`output`, `reply`, `reply_language`) and the agent scratchpad
   (`agent_messages`, `agent_steps`, `failure_reason`) are **explicitly cleared by `normalize`**.

> **Why `normalize` must clear.** The checkpointer persists the *whole* state blob per thread, so
> a channel that no node happens to overwrite this turn keeps last turn's value. For channels
> that are always written (`intent`, `cart_view`) that's harmless; for the terminals and the
> scratchpad it is not — a stale `reply` would be re-spoken, and a stale `agent_messages` would
> re-seed the loop with last turn's (possibly stale) menu data. Clearing them in `normalize` is
> what keeps them turn-scoped.

`reply_language` gets its own channel rather than riding the input `language` for exactly this
reason: a declaration is evidence about the turn that made it, and a shared channel once leaked
it into later turns that declared none.

---

## 4. Nodes, one by one

### `normalize`

```ts
customer_text: normalizeTranscript(s.customer_text),
output: null, reply: null, reply_language: undefined,
agent_messages: [], agent_steps: 0, failure_reason: undefined,
```

- `normalizeTranscript` (`nodes/normalize-transcript.node.ts`) is just
  `text.trim().replace(/\s+/g, ' ')` — collapse whitespace.
- **Critically, it resets every turn-scoped channel** — see the box in §3.

### `classify`

```ts
if (s.history.at(-1)?.agent_reply !== undefined) return { intent: 'service' as const };
const intent = await classifyIntent(intentLlm, s.customer_text);
return { intent };
```

- Runs **right after `normalize`**, on the NORMALIZED utterance. Sets the `intent` channel, which
  the conditional edge reads to route the turn (§2).
- **Pending-reply override:** if the previous turn ended by SPEAKING (its `agent_reply` is the
  last history entry), THIS utterance is likely the answer to it, so `classify` forces
  `intent = 'service'` and skips the classifier LLM call entirely — the agent resolves the reply
  against the current utterance. Without this, a terse answer ("both", "the second one") could be
  mislabeled `junk` and dropped. Note it keys on the **immediately** preceding turn: once a turn
  proposes (recording no `agent_reply`), a later fresh junk utterance short-circuits normally.
- `classifyIntent` (`nodes/classify-intent.node.ts`) calls its OWN LLM provider (`intentLlm`,
  built from `INTENT_LLM_*` env by `createIntentLlmProvider`, falling back to `LLM_*` — so the
  classifier can run on a cheaper/separate model+key than the agent) with `buildIntentPrompt`
  (`llm/intent-prompt-builder.ts`), JSON-parses, and validates against `intentSchema`. It
  **degrades to `service` on any failure** (transport error, non-JSON, non-object payload,
  unknown label): a real order must never be dropped. The `stub` provider returns a non-intent
  JSON, so it always degrades to `service` — i.e. stub deployments always run the agent.

### `load_cart`

```ts
const cart = await loadCart(carts, s.cart_id, s.pos_config_id);
const cart_view = await buildCartView(menu, cart);
return { cart_view, base_version: cart.version };
```

- `loadCart` reads the cart from `CartCache`, falling back to `emptyCart(...)` when absent — a
  first turn on a new cart still gets a valid (empty) snapshot.
- `base_version` is captured here as `cart.version` and then **rides the whole turn untouched**
  (lww, not rewritten by later nodes), so the eventual proposal always carries the version it was
  computed against — the basis for optimistic concurrency downstream (design §9).
- `buildCartView` (Plan A) projects the stored cart into a **self-describing** `CartView`: one
  batched `menu.getItems` read resolves each line to its `name` + `menu_item_key`, maps each
  attached `ptav_id` to `{modifier_key, name}`, and lists the item's `available_modifiers`.
  Numeric `product_tmpl_id`/`ptav_id` are deliberately **omitted** so the model can't confuse one
  for a `line_id`. It degrades gracefully (numeric-id fallback for name/key, dropped unknown
  modifiers) so a stale cart line never throws.

### `agent`

One LLM tool-calling turn — the heart of the graph (§5).

```ts
const step = s.agent_steps + 1;
if (step > LIMITS.maxAgentSteps) return { failure_reason: 'agent_step_limit' };
const messages = s.agent_messages.length === 0 ? seedMessages(s) : s.agent_messages;
const res = await llm.chat(messages, TOOL_SPECS);
```

- **Seeds on first entry** (`agent_messages` empty) via `buildAgentMessages` — system prompt +
  user context — then appends the model's assistant reply to the scratchpad. On later iterations
  it re-sends the accumulated scratchpad.
- The `language` channel is deliberately NOT passed to the prompt: it holds the unreliable
  STT-detected code, and the agent reads the language off `customer_text` instead.
- **Step guard:** `maxAgentSteps` (8) caps `agent` LLM turns per customer turn. Exhaustion sets
  `failure_reason: 'agent_step_limit'` — a cost/latency guard and runaway-loop backstop, sized to
  allow several sequential per-item searches before a `propose_cart`.
- **No tool call → the agent ended by speaking.** The reply is strict JSON `{language, reply}`;
  `parseSpokenReply` extracts it and the node records `reply` + `reply_language`. A blob with no
  usable reply sets `failure_reason: 'agent_no_terminal'`.

### `tools`

```ts
.addNode('tools', node('tools', (s) => runTools(menu, s)))
```

- Runs the tool calls the agent just requested, appends each result to `agent_messages` as a
  `{role:'tool'}` message, and carries the `output` a successful `propose_cart` set (§5.2).

### `finalize`

```ts
history: [{
  customer_text: s.customer_text,
  ...(s.reply !== null ? { agent_reply: s.reply } : {}),
}]
```

- The single terminus before `END`. Appends **one** `HistoryTurn` for the whole turn — the
  utterance plus, when the agent ended by SPEAKING, the reply it spoke.
- `agent_reply` is what makes the next turn work: it feeds `classify`'s pending-reply override
  and gives the next agent the context to resolve an answer. A turn that committed operations (or
  failed) records only its utterance.
- `history`'s appending+capped reducer means the next turn's agent re-sends the newest ≤6 turns
  as conversation context so references ("that", "the same one") resolve. History is
  **reference-only** — the prompt forbids re-executing a past request; `current_cart` is the
  source of truth for what's actually in the cart. The `agent_messages` scratchpad is **never**
  written to history.
- The `junk` route skips `finalize` entirely (routes straight to `END`).

---

## 5. The agent ⇄ tools loop

This is the heart of the turn and the reason the graph exists in this shape.

### 5.1 The loop edges

```ts
.addConditionalEdges('agent', (s) => {
  if (s.failure_reason !== undefined || s.reply !== null) return 'finalize';
  return lastAssistantHasToolCalls(s) ? 'tools' : 'finalize';
}, { tools: 'tools', finalize: 'finalize' })

.addConditionalEdges('tools', (s) => (s.output !== null ? 'finalize' : 'agent'), {
  agent: 'agent', finalize: 'finalize',
})
```

The routers are **channel-driven, not intent-driven**: the loop continues precisely while no
terminal channel has been written. `tools → agent` fires whenever `propose_cart` did not validate
— which is exactly what makes a failed proposal retriable (§5.2).

### 5.2 The tools (`tools/tool-specs.ts`, `tools/run-tools.ts`)

Two tools, and the asymmetry between them is the design:

| Tool | Kind | Effect |
|---|---|---|
| `search_menu_semantic` | retrieval, **loopable** | `menu.getCandidates(pos_config_id, query)` → candidate items as the tool result. The agent may call it several times (e.g. once per distinct item). |
| `propose_cart` | **terminal action** | zod-validates `operations` via `parseOrderGraphOutput`; on success sets `output` and the turn ends. Optional `reply`/`language` args bundle a spoken confirmation, which the node writes to `reply`/`reply_language` alongside `output`. |

- **Candidates are NOT pre-fetched.** Unlike the old fixed `retrieve` node, the agent decides what
  to search for and when — the reason a multi-item order works without a retrieval heuristic.
- **Clarifications and recommendations are NOT tools.** The agent expresses both by ending the
  turn with a plain spoken reply, which the graph surfaces as the single `reply` outcome.
- **A `propose_cart` that fails validation is a retriable tool error, not a turn failure.** It
  sets no `output`, so the loop router sends control back to the agent with the validation message
  as the tool result — the schema-repair loop, expressed as an ordinary loop iteration.
- **An empty `operations` array is rejected on purpose.** `operations` defaults to `[]` when
  absent, so a malformed call would otherwise "succeed" as an empty proposal and silently drop the
  customer's request. `run-tools.ts` rejects it with a message telling the agent to reply in words
  instead.
- `propose_cart`'s advertised `parameters` JSON Schema is deliberately **loose** (`items: {type:
  'object'}`); the precise contract lives in the system prompt (which embeds the real schema
  generated from `cartOperationSchema`) and zod does the enforcing.

### 5.3 The two terminals

The agent ends every turn one of two ways:

1. **`propose_cart`** → `output` set → `finalize` → `{status:'complete'}`. It **may also** carry a
   short spoken confirmation via optional `reply`/`language` args — the `tools` node then sets
   `reply`/`reply_language` **alongside** `output`, so one terminal call both commits and speaks
   (approach B). `output` and `reply` are therefore **no longer mutually exclusive**.
2. **A spoken reply** (no tool call) → `reply` set (no `output`) → `finalize` → `{status:'reply'}`.

When the turn has anything to commit it MUST end with `propose_cart` (any words go in its `reply`);
a standalone spoken reply is only for turns with nothing to commit. So `propose_cart` is always the
agent's **last** tool call — all `search_menu` calls come first.

**A reply is fire-and-forget — there is no pause, no interrupt, and no checkpointer resume.** The
turn emits the reply and ends, releasing its per-cart FIFO slot. The customer's answer arrives as
the **next transcript**, where `classify`'s pending-reply override force-routes it to `service` and
the agent resolves it against `conversation_history`. This is why the old `MAX_CLARIFICATION_ROUNDS`
cap and clarification stall timeout are gone: a multi-turn conversation is just turns.

### 5.4 The spoken-reply contract (`graph/parse-spoken-reply.ts`)

The reply is strict JSON `{"language": "...", "reply": "..."}`. **`language` is demanded FIRST for
a generation-order reason, not a stylistic one:** the model writes left to right, so a
`reply`-first shape lets it write the whole reply — drifting into whatever language
`conversation_history` is in — and only then label what it already wrote, making `language`
describe the drift instead of preventing it (observed: a zh → zh → en session answered in zh).
Emitting the code first forces the choice before any reply token exists.

The ordering is enforced **only by the prompt**. `parseSpokenReply` JSON-parses, so field order is
irrelevant there and a model that slips back to `{reply, language}` still keeps its language.

It degrades **per-field**, and each degradation is chosen so a customer never hears something
worse than the alternative:

| Input | Result | Why |
|---|---|---|
| `{"language":"es","reply":"¿Cuál prefieres?"}` | `{reply, language:'es'}` | the contract |
| ` ```json {...}``` ` | fence stripped, then parsed | prompt forbids fences; models emit them anyway |
| `Sure! {"reply":"..."}` | outermost `{...}` span parsed, prose dropped | requiring a bare object would read the braces aloud |
| plain prose, no `{` | `{reply: <text>}` | never drop a reply — speak it as-is |
| valid JSON, no usable `reply` | `{reply: null}` → `agent_no_terminal` | never read a JSON blob aloud |
| `{"language":"Chinese","reply":"..."}` | `{reply}`, no language | an off-format code costs only the language; TTS falls back to `TTS_LANGUAGE` |

---

## 6. What is persisted vs. what is sent to the LLM

Three distinct sets are easy to conflate. The checkpointer persists the *entire* state blob per
thread, but that is not the same as what carries forward across turns, which is not the same as
what the model actually reads.

### 6.1 Persisted across turns

The `MemorySaver` checkpoint holds the whole `OrderState` per thread, but on each turn almost
every channel is overwritten — by the invoke input (ids, `customer_text`, `supported_languages`),
by the nodes (`intent` in `classify`, `cart_view`/`base_version` in `load_cart`), or by
`normalize`'s explicit reset (the terminals + the agent scratchpad). The one channel with an
**append** reducer, and thus the only meaningful cross-turn carryover, is:

- **`history`** — the `finalize`-appended `HistoryTurn[]`, capped at `LIMITS.maxHistoryTurns = 6`
  (oldest→newest). Everything else is effectively per-turn even though it is checkpointed.

### 6.2 Recomputed every turn

`customer_text` (normalized), `intent`, `cart_view`, `base_version`, the terminals, the agent
scratchpad, and the input ids (re-supplied on each invoke). `base_version` is captured at
`load_cart` and returned in the `complete` result, but it is **not** sent to the LLM.

### 6.3 Actually sent to the LLM

`buildAgentMessages` (`llm/agent-prompt-builder.ts`) builds a two-message seed transcript:

- **system** — `buildAgentSystemPrompt()`: the WORKFLOW (search first, then either `propose_cart`
  or a spoken reply), the KEY RULES for operations, the CONTEXT RULES, and the LANGUAGE section.
  It embeds the **JSON Schema for a `propose_cart` operation**, generated from
  `cartOperationSchema` via `z.toJSONSchema` (with a `scrubSchema` pass to drop sentinel
  `maximum`/`$schema` noise), so the advertised shape can't drift from validation. The schema pins
  STRUCTURE only; the prose KEY RULES carry the semantics a schema can't express (key provenance,
  the inline-modifier rule, matching a cart line by name).
- **user** — `buildAgentUserMessage(ctx)`, exactly three fields:

```jsonc
{
  "customer_text":        "...",          // normalized utterance
  "current_cart":         { ... },        // self-describing CartView
  "conversation_history": [ ... ]         // = state `history`, RENAMED
}
```

| State / input | Reaches the LLM? | Notes |
|---|---|---|
| `customer_text` | yes | the utterance; also the **sole** authority on reply language |
| `cart_view` | yes → as **`current_cart`** | source of truth for what's in the cart |
| `history` | yes → as **`conversation_history`** | reference-only |
| candidate items | **not up front** | the agent fetches them via `search_menu_semantic` |
| `request_id` / `session_id` / `cart_id` / `pos_config_id` | **no** | correlation + menu scope only |
| `base_version` | **no** | graph-internal; returned in the result |
| `supported_languages` | **no** | dead channel — see below |

> **No language hint is passed, on purpose.** The STT code tags nearly every turn `en`, and a
> wrong hint is worse than none — it argues the customer spoke English when they plainly didn't.
> The agent reads the language off `customer_text`, which is the actual evidence.

> **Known dead code** (left from the agent rework, documented rather than silently carried):
> `supported_languages` is threaded input → state but read by nothing and always `[]` (there is a
> TODO to source it from `voice_restaurant_settings`); `TIMEOUTS.clarificationMs` and
> `schemas/clarification.schema.ts` have no consumers now that replies don't pause the graph; and
> `StubLlmProvider.complete` still returns `needs_clarification`/`clarification_question` fields
> that the output schema no longer has (harmless — it degrades to `service` either way).

---

## 7. Output contract & failure modes

`schemas/order-graph-output.schema.ts` (zod) is now minimal — clarification fields are gone,
because a clarification is a spoken reply, not a proposal:

```ts
const outputSchema = z.object({
  operations: z.array(cartOperationSchema).default([]),
});
```

`parseOrderGraphOutput` returns a `Result`; on failure it carries a repair-friendly message from
`formatZodError` (`zod-error.ts`) that feeds straight back to the agent as the tool result.

How the graph turn can end (`OrderGraph.interpret`, checked in this order):

| Outcome | Trigger | Surfaced as |
|---|---|---|
| Junk | `intent === 'junk'` — the agent never ran | `{status:'junk'}` → service logs `order.intent_junk`, ends quietly |
| Failure | `failure_reason` set (`agent_step_limit`, `agent_no_terminal`) | `{status:'fail', reason}` → `voice.session_failed` |
| Proposal | `output` set by a validated `propose_cart` | `{status:'complete', reply?, language?}` → `order.operations_proposed`, then `order.reply` if the call bundled a confirmation |
| Reply | `reply` set by a spoken terminal (no `output`) | `{status:'reply', reply, language?}` → `order.reply` |
| Node fault | any node throws (e.g. Redis in `load_cart`) | `order.node_failed` (tagged with node) → `invoke()` rejects → service catches → `fail` (`order_parse_failed`) |

The order matters: `junk` is checked first (nothing ran), then `failure_reason` (so a step-limit
bail isn't misread as a silent success), then the terminals. A run that reaches the end with
neither a terminal nor a failure reason falls through to a defensive
`{status:'fail', reason:'agent_no_terminal'}`.

Note the two failure *paths*: the agent's own dead-ends surface as a `fail` **result**, whereas a
node throw **rejects** `invoke()` and is caught by the service. Both end as
`voice.session_failed`, distinguished by `reason`.

---

## 8. Invariants worth preserving

1. **`finalize` is the only path to `END` for a turn that ran the agent.** Every agent route
   passes through it, so history is recorded exactly once. Don't add an edge that skips it.
   (`junk` is the deliberate exception — it must NOT be recorded.)
2. **`normalize` must clear every turn-scoped channel.** The checkpointer persists everything, so
   a channel left unclear leaks into the next turn. Adding a turn-scoped channel means adding it
   to `normalize`'s reset.
3. **`base_version` is captured once at `load_cart` and never rewritten**, so the proposal's
   version matches the snapshot it was computed from.
4. **The loop routers stay channel-driven.** `tools → agent` must fire whenever no terminal was
   written; that is what makes a failed `propose_cart` retriable rather than fatal.
5. **A `propose_cart` may also set `reply`.** `output` and `reply` are **not** mutually exclusive:
   a single terminal `propose_cart` can commit operations *and* speak a short confirmation (approach
   B — the operations go out first as `order.operations_proposed`, then the reply as `order.reply`).
   A standalone spoken reply (no tool) still sets only `reply` and is for turns with nothing to
   commit.
6. **Reducers stay pure/deterministic** (LangGraph requirement) — see the extracted `mergeHistory`.
7. **No numeric ids in the prompt-facing views.** `cart_view` exposes keys/names/`line_id` only,
   by design, so the model can't confuse a `product_tmpl_id`/`ptav_id` for a `line_id`.
8. **`reply_language` stays turn-scoped.** A language declaration is evidence about the turn that
   made it; sharing the channel once leaked it into later turns that declared none.

---

## 9. File map

| File | Role |
|---|---|
| `order-graph.ts` | Façade: `start()` / `interpret()`, thread config; maps channels → `GraphTurnResult`. |
| `graph/build-graph.ts` | Node definitions, edges, intent routing, the agent ⇄ tools loop, compile+checkpointer. |
| `graph/intents.ts` | `intentSchema` (`service`/`junk`) + `INTENT_ROUTE` — the intent set and its routing table. |
| `graph/state.ts` | `OrderState` annotations, `lww`/`appendHistory` reducers, `mergeHistory`. |
| `graph/instrument.ts` | `node(name, fn)` — per-node error logging, bubble-up passthrough. |
| `graph/parse-spoken-reply.ts` | `parseSpokenReply` — the `{language, reply}` terminal, degrading per-field. |
| `tools/tool-specs.ts` | `TOOL_NAMES` + `TOOL_SPECS` — the tools advertised to the agent. |
| `tools/run-tools.ts` | The `tools` node: executes calls, appends results, sets `output` on a valid `propose_cart`. |
| `nodes/classify-intent.node.ts` | LLM junk-gate classifier; degrades to `service` on any failure. |
| `nodes/normalize-transcript.node.ts` | Whitespace normalization. |
| `nodes/load-cart.node.ts` | `loadCart` + `buildCartView` (self-describing projection). |
| `llm/agent-prompt-builder.ts` | The agent's system prompt + user context (the seed transcript). |
| `llm/intent-prompt-builder.ts` | `buildIntentPrompt` — the binary junk-gate prompt. |
| `schemas/order-graph-input.schema.ts` | `CartView`, `CartLineView`, `HistoryTurn` types. |
| `schemas/order-graph-output.schema.ts` | `propose_cart`'s output zod schema + `parseOrderGraphOutput`. |
| `schemas/cart-operation.schema.ts` | The operation union — drives both prompt and validation. |
