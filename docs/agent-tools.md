# Order Understanding — Agentic Tool-Calling (spec)

Status: **implemented** (branch `feat/agent-rework`). Reworked the `order` path from a
fixed `retrieve → parse` pipeline into an **LLM agent that calls tools**. The old pipeline
is removed entirely — the agent graph is the only path; there is no feature flag.

> **Revision 2 (implemented):** the retrieval tool is now **`search_menu`**, not
> `search_menu_semantic` — it takes `{query?, sort?, max_price_cents?, min_price_cents?,
> limit?}` and is no longer purely semantic. Every mention of `search_menu_semantic` below
> should be read as `search_menu`; the tool *count* (two) and everything else in this doc are
> unchanged. This subsumes the deferred `filter_menu` / `popular_items` (§2, §8): they are
> parameters on one tool rather than tools of their own, so "popular AND has fish" is
> intersected server-side instead of by the model. Category/dietary filtering did **not**
> land — the schema has no ingredient or dietary field at all. See
> `docs/plans/agent-search-extension.md`.

> **Revision (implemented):** clarify and suggest are **not tools**. The agent has two tools
> (`search_menu_semantic`, `propose_cart`) and ends a turn either by proposing or by replying
> (no tool call) with strict JSON `{language, reply}` — one merged **`reply`** outcome that serves as both a
> clarifying question and a recommendation (spoken-only, no structured items). This replaces
> the `ask_clarification`/`suggest_items` tools and collapses `order.clarification_needed` +
> `order.suggestion_ready` into a single `order.reply` event. The consecutive-clarification cap
> was dropped (a merged reply shouldn't cap multi-turn conversation; `maxAgentSteps` bounds
> within-turn runaway). Sections below are kept for rationale; where they mention the four-tool
> design, the two-tool + reply-outcome shape above is authoritative.

> **Revision 2 (implemented):** the intent set is now **binary** — `intentSchema` is
> `['service', 'junk']` and `INTENT_ROUTE` is `{ service: 'load_cart', junk: END }`. Demoting
> classify to a junk-gate (below) had already made `order` and `suggest` route identically, and
> nothing downstream read the difference (`interpret` only asks `intent === 'junk'`), so the
> three-way split was a distinction with no behavior behind it — it only gave the classifier a
> way to be wrong. `service` now covers ordering, edits, recommendations, and menu questions.
> The degrade-to-default and force-after-a-reply behaviors are unchanged in substance; both now
> yield `service`. Where sections below say `order`/`suggest`, read `service`.

Scope: `src/ordering/graph/`, `src/ordering/nodes/`, `src/ordering/tools/` (new),
`src/llm/` (provider tool-calling), `src/config/`. The service loop, event
contracts, cart module, and menu store queries are unchanged in Phase 1.

---

## 1. Problem

Today the LLM is passive. `retrieve` (`nodes/retrieve-candidates.node.ts`) runs one
hybrid KNN+lexical search over the raw transcript and drops the top‑N into the
`candidates` channel; `parse` (`nodes/parse-order.node.ts`) hands the model *only*
those candidates and asks for operations. The model **never decides what to search
for** — if the right item isn't in the pre-computed candidate set, it can't recover.
Recommendations (`suggest` node) and clarifications (parse's `needs_clarification`
branch) are separate fixed routes chosen by an upstream classifier, not by the model
reasoning over what it actually found.

Goal: let the model **drive retrieval** — issue its own searches based on the
customer's request — and **decide the outcome** (propose / clarify / suggest) from
what it retrieves.

## 2. Scope

**In (Phase 1):**
- A tool-calling `LlmProvider` abstraction (native OpenAI `tools`/`tool_calls`).
- One retrieval tool: `search_menu_semantic` (wraps the existing
  `menu.getCandidates`).
- Three terminal tools: `propose_cart`, `ask_clarification`, `suggest_items`.
- A LangGraph agent loop (`agent ⇄ tools`) that **replaces** `retrieve → parse` and
  the `suggest` node outright. The old nodes are deleted; there is no feature flag.
- The intent classifier demoted to a **junk-gate**.

**Out (later phases / explicitly deferred):**
- ~~`filter_menu` (structured category/dietary/price search)~~ / ~~`popular_items`~~ —
  **superseded.** Both landed, but as parameters on a single `search_menu` tool rather than
  as separate tools, because "popular AND has fish" is one intersection and two tools would
  force the *model* to intersect two result sets. **Category** and **dietary** filtering did
  NOT land and are not deferred work but data gaps: `product_template` carries no ingredient,
  tag, or dietary field, so "has fish" is only ever a NAME match. See
  `docs/plans/agent-search-extension.md` §2/§4.
- Prompted-ReAct (non-native) tool-calling fallback — deferred; the agent uses native
  tool-calling only, so production must run a tool-capable model (see §4).
- Any change to event contracts, the cart module, or the STT/voice path.

## 3. Target architecture

The agent gathers candidates by calling `search_menu_semantic` (possibly several
times), then **commits to exactly one terminal tool**. The terminal choice — not an
upstream router — determines the turn's outcome.

| Turn ends by… | Replaces | Façade `GraphTurnResult` → event |
|---|---|---|
| calling `propose_cart(operations)` | `parse` output | `complete` → `order.operations_proposed` |
| calling `propose_cart(operations, reply, language?, mentioned_items?)` | — | `complete` → `order.operations_proposed`, then `order.reply` (bundled confirmation) |
| replying (no tool call) with JSON `{language, reply, mentioned_items?}` | parse's `needs_clarification` branch **and** the `suggest` node | `reply` → `order.reply` |

`propose_cart` accepts optional `reply`/`language` args so one terminal call can commit **and**
speak a short confirmation (e.g. "Added two lattes — anything else?"). When the turn has anything to
commit it must end with `propose_cart` and put any words in its `reply`; a standalone spoken reply is
only for turns with nothing to commit, so `propose_cart` is always the agent's last tool call.

Both terminals also take an optional **`mentioned_items`** — the `menu_item_key`s the reply just
named — under the same name, parsed by the same function (`graph/parse-agent-reply.ts`), so the two
cannot drift. The agent declares keys only; the server echoes name/price from the search result it
was shown, so the model can never mis-state a price it just read. See §11.

(As implemented — see the revision note at the top. `ask_clarification`/`suggest_items` were
not built; a spoken reply is the single merged terminal alongside `propose_cart`.)

**The reply is still not a tool** — it remains the no-tool-call terminal — but its message body is
strict JSON rather than bare text:

```json
{"language": "zh", "reply": "您想要什么饮料?"}
```

`language` is the ISO-639-1 code of the language the agent *actually wrote* `reply` in; it sets
`order.reply.language`, which TTS speaks the reply in (`docs/text-to-speech.md` §Multilingual). It is
the **only** source of the reply's language — the STT-detected code is not consulted, not even as a
fallback; a reply that declares none falls back to `TTS_LANGUAGE`.

**`language` comes first for a generation-order reason.** The model emits JSON left to right, so a
`reply`-first shape let it write the entire reply — drifting into whatever language
`conversation_history` was in — and only then label what it had already written, making `language` an
accurate description of the drift rather than a guard against it. This showed up as a
Chinese → Chinese → English session still being answered in Chinese. Emitting the code first forces
the choice before any reply token exists and conditions the reply on it. The parser is
order-agnostic, so this ordering is enforced only by the prompt.

The agent is given **no language hint** in its user context — deliberately. The STT-detected code
was previously passed as a `language` field, but it tags nearly every turn `en`, so it argued the
customer spoke English even on a plainly Chinese utterance; a wrong hint is worse than none. The
prompt's LANGUAGE section instead makes `customer_text` the sole authority (it is the actual
evidence), requires the reply to match the LATEST utterance so a mid-conversation switch is
honoured, and allows falling back to the last identifiable utterance's language only when the
current one is too short to read (`"OK"`, `"two"`, a bare item name).

`ordering/graph/parse-agent-reply.ts` parses the terminal and degrades **per-field**, so a format
slip is never a dropped reply:

| Agent emitted | Outcome |
|---|---|
| `{"language":"zh","reply":"…"}` | reply spoken in `zh` |
| `{"reply":"…","language":"zh"}` | reply spoken in `zh` — the prompt asks for language-first, but the parser accepts either order |
| `{"reply":"…"}` | reply spoken in `TTS_LANGUAGE` (the fallback when none is declared) |
| `{"language":"Chinese","reply":"…"}` | reply spoken in `TTS_LANGUAGE`; the off-format code is dropped |
| `Sure! {"language":"zh","reply":"…"}` | the object is unwrapped from the prose; reply spoken in `zh` |
| plain text (no JSON) | text spoken as-is, in `TTS_LANGUAGE` |
| malformed/truncated JSON | raw text spoken (better than dropping a reply) |
| valid JSON, no usable `reply` | `agent_no_terminal` — a blob is never read aloud |
| `{…,"mentioned_items":["k1","k2"]}` | keys resolved against this turn's searches; the verified items ride on `order.reply` |
| `{…,"mentioned_items":"k1"}` or `[1,""]` | items degrade to none; the reply is spoken unchanged |
| `mentioned_items` naming a never-searched key | that key is dropped with an `order.mentioned_item_unresolved` warn; the rest survive |

The parser reads the **outermost `{…}` span** rather than requiring the message to be exactly the
object, so prose wrapped around it (`Sure! {…}`) is dropped instead of being read aloud verbatim.

The façade, `order-understanding-service.ts`, and all event contracts are
**unchanged** — only *who* decides the outcome moves from fixed routing to the agent.

### 3.1 Graph (agent path)

```
normalize → classify → load_cart → agent ⇄ tools → finalize → END
                     └─(junk)──────────────────────────────────→ END
```

- **classify** — kept, but demoted to a **junk-gate**. `INTENT_ROUTE`
  (`graph/intents.ts`) is edited so `order` **and** `suggest` both → `agent`, and
  `junk` → `END`. This preserves the cheap first-hop LLM call that skips the whole
  agent loop for non-orderable utterances, and keeps junk's "don't pollute history"
  behavior. The classifier's degrade-to-`order` and force-`order`-when-clarification-
  pending logic still apply (both simply route into the agent now). One-row table
  edit; the classifier prompt/schema/set are otherwise untouched.
- **load_cart** — unchanged, runs once before the agent (the agent needs
  `cart_view`).
- **agent** — new node. Sends the system prompt + user context (`customer_text`,
  `current_cart`, `history`, pending `clarification_question`) + the tool schemas to
  the LLM. If the model returns tool calls, they run in the `tools` node and loop
  back; when it returns a terminal tool call, its result is written to the `output`
  (or `suggestion`) channel and the graph proceeds to `finalize`.
- **tools** — LangGraph `ToolNode` (or equivalent) executing the requested tool
  calls, appending results to the turn-scoped scratchpad, and returning to `agent`.
- **finalize** — unchanged. Records the turn to cross-turn `history` (see §5).

### 3.2 Nodes deleted

`retrieve`, `parse`, and `suggest` are **removed** (files deleted, not conditionally
skipped). Their logic relocates:

- **retrieve** → the `search_menu_semantic` tool handler.
- **parse + schema-repair** → validating the `propose_cart` tool arguments against
  the existing `order-graph-output` / `cart-operation` zod schemas. On failure, a
  **tool error** (using `zod-error.ts`'s repair-friendly message) is returned to the
  agent, which retries within `maxAgentSteps`. This reuses the repair contract
  without the separate `buildRepairPrompt` round. **`maxAgentSteps` is the single
  ceiling** — `LIMITS.llmMaxRetries` no longer applies on the agent path; a
  validation failure is simply another tool-error step in the loop.
- **suggest** → the `suggest_items` terminal tool handler (reuses the
  candidate-echo filtering rules: item `name`/`names` come from the matched
  candidate, keys deduped — the menu stays the source of truth).

## 4. LLM provider changes (`src/llm/`)

Add tool-calling alongside the existing single-shot `complete()`:

```ts
// llm-provider.ts (additive)
interface ToolSpec { name: string; description: string; parameters: object; } // JSON Schema
interface ToolCall { id: string; name: string; arguments: unknown; }          // parsed args
type AgentMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content?: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface LlmProvider {
  readonly name: string;
  complete(prompt: LlmPrompt): Promise<string>;                 // unchanged
  chat(messages: AgentMessage[], tools: ToolSpec[]): Promise<{  // new
    text?: string;
    toolCalls: ToolCall[];
  }>;
}
```

- **`OpenAiCompatibleLlmProvider`** — implement `chat` via the OpenAI SDK's `tools`
  param and `response.choices[0].message.tool_calls`. `temperature: 0`. Same
  base-URL/creds injection, so Ollama/OpenAI/Groq all work if the model supports
  tool-calling.
- **`StubLlmProvider`** — `chat` returns a **scripted** tool-call sequence so tests
  stay deterministic (e.g. one `search_menu_semantic` then `propose_cart`).
- `complete()` stays for the intent classifier and (if it remains) any non-agent
  caller.

**Mechanism decision:** native tool-calling only. With the old pipeline gone there is
no non-agent fallback, so **production must run a tool-capable model** (Groq/OpenAI/
qwen, etc.); the scripted `StubLlmProvider` covers tests. Tool *schemas* are
transport-independent, so adding a prompted-ReAct loop later (for weak models) would
not change the tool definitions — it is the deferred escape hatch, not the flag.

## 5. State & conversation-history model

The agent adds a second, finer memory scope. Keeping the two scopes separate is a
**hard requirement** — otherwise the `MemorySaver` checkpoint balloons and stale
menu data leaks across turns.

| Scope | Contents | Lifetime | Persisted across turns? |
|---|---|---|---|
| **Within-turn scratchpad** | the `agent_messages` loop (assistant tool_calls ↔ tool results) + accumulated `candidates` | one graph invoke | **No** |
| **Cross-turn history** | compact per-turn record | many turns (checkpointer) | **Yes** |

- **`agent_messages`** — a new state channel holding the turn's tool-calling
  transcript. It is **turn-scoped**: cleared in `normalize` each fresh turn, exactly
  as `candidates` and `suggestion` already are (`build-graph.ts:66`). It exists only
  so the model can search → read → search again *this turn*, then is discarded. It is
  **never** written into cross-turn `history`.
- **`candidates`** — stays per-turn (last-write-wins / accumulate within the turn),
  capped at `LIMITS.maxCandidatesToLlm`.
- **`search_results`** — turn-scoped map (`menu_item_key` → `MentionedItem`) accumulating what
  every `search_menu` call in the turn returned, across agent steps. It is what a declared
  `mentioned_items` key is verified against, and it is **cleared by `normalize`** — a key is only
  ever checked against searches the agent ran *this* turn (§11).
- **`mentioned_items`** — turn-scoped, the verified `MentionedItem[]` for this turn's reply.
- **Cross-turn `history`** — unchanged. `finalize` records per turn:
  - `customer_text` — always.
  - `clarification_question` — if the terminal was `ask_clarification`.
  - `suggested_items` — if the terminal was `suggest_items`.

  Reference resolution ("the same", "another one of those") continues to resolve
  against `current_cart` (the `cart_view`, sole source of truth) + the compact
  history text — **not** against the tool transcript, which is stale by the next turn
  (menu availability/prices are read fresh every turn). We deliberately do **not**
  record the agent's proposed item names into history (redundant with `current_cart`,
  and it risks the model replaying a past request). Revisit only if
  reference-resolution tests show a gap.

## 6. Config (`src/config/`)

- **`LIMITS.maxAgentSteps`** — cap on `agent ⇄ tools` iterations per turn (cost/latency
  guard + runaway-loop backstop). On exhaustion the turn fails via `voice.session_failed`
  with reason **`agent_step_limit`** (new, parallel to the existing `order_parse_failed`).
  *(The value is **8** in `config/constants.ts`, not the 4 this doc originally proposed —
  sized to let a multi-item order run several sequential searches before proposing. The
  constant is authoritative; §9 below is the stale proposal.)*

No `ORDERING_AGENT` flag: `build-graph` unconditionally builds the agent graph (§3.1).

## 7. Tradeoffs / risks

- **Latency.** An agent loop is multiple sequential LLM round-trips per turn vs. the
  old single call — a real hit for a voice UX. Mitigations: `maxAgentSteps` ≈ 2–3,
  allow parallel tool calls within one step, `temperature: 0`.
- **No fallback path.** Removing the pipeline means a tool-calling failure has no
  graceful degrade — the turn fails (or hits `maxAgentSteps`). Accepted for this
  branch; the deferred prompted-ReAct loop (§4) is the future escape hatch for weak
  models.
- **Production requires a tool-capable model.** The stub keeps tests deterministic,
  but a non-tool-calling runtime model cannot drive the graph at all.

## 8. Phasing & verification

- **Phase 1 — provider tool-calling.** `chat()` on the interface, real provider, and
  scripted stub. *Verify:* a unit test round-trips `chat` (stub emits a tool call;
  real provider parses `tool_calls` from a recorded response).
- **Phase 2 — agent graph replaces the pipeline.** `agent` node, `tools` node,
  `agent_messages` channel, `INTENT_ROUTE` junk-gate edit, the four tools,
  `propose_cart` validation→tool-error retry. **Delete** `retrieve`, `parse`, and
  `suggest` nodes (and their now-orphaned tests/helpers). *Verify:* the existing
  behaviors in `order-understanding-service.test.ts` (happy path, edits,
  fire-and-forget clarify, consecutive-clarify cap, per-cart FIFO) plus
  `suggest.node`-equivalent recommendation behavior are migrated to and pass on the
  agent graph. No pipeline path remains to keep green.
- **Later:** ~~`filter_menu`, `popular_items`~~ — landed as `search_menu` parameters
  (`docs/plans/agent-search-extension.md`); optional prompted-ReAct fallback for weak models.

## 9. Resolved decisions

- **`maxAgentSteps = 4`**; exhaustion fails the turn via `voice.session_failed`
  reason `agent_step_limit` (§6).
- **Single retry ceiling.** `propose_cart` validation failures retry as ordinary
  tool-error steps bounded by `maxAgentSteps`; `LIMITS.llmMaxRetries` does not apply
  on the agent path (§3.2).
- **Clarify + suggest merged into one `reply` outcome (revision).** The agent has two tools
  (`search_menu_semantic`, `propose_cart`); it ends a turn either by proposing or by replying
  with a spoken message. The reply is spoken-only (no structured `suggested_items`). One event
  `order.reply` replaces `order.clarification_needed` + `order.suggestion_ready` (WS protocol
  change). `GraphTurnResult` = `complete | reply | junk | fail`.
- **Consecutive-clarification cap dropped (revision).** With clarify/suggest merged, a
  multi-turn conversation shouldn't trip a cap; within-turn runaway is bounded by
  `maxAgentSteps`. Removed `LIMITS.maxClarifications`, `clarification_unresolved`,
  `trailingClarificationRun`.
- **Force-order after a reply.** A reply is fire-and-forget; the next turn's `classify`
  force-orders when the last history turn carries `agent_reply`, so a terse follow-up isn't
  misrouted to junk. (Generalizes the old pending-clarification behavior.)

## 10. Knowledge-base updates (on implementation)

Per repo convention, the implementing change must update
`.claude/.knowledge/ordering/overview.md` and `llm/overview.md` (new node/tool set,
`agent_messages` channel, provider `chat`) and append a `log.md` entry.

---

## 11. Mentioned items on `order.reply` (implemented)

A reply that names menu items now carries them as structured data, so the client can render what
was just spoken instead of only playing it. Plan: `docs/plans/mentioned-items.md`.

**The agent declares keys; the server echoes the data.** Both terminals take an optional
`mentioned_items: string[]` of `menu_item_key`s, in the order the reply names them — never names,
never prices. Each key is resolved to a `MentionedItem` (`contracts/mentioned-item.ts`:
`menu_item_key`, `product_tmpl_id`, `name`, `base_price_cents`, optional `popularity`) echoed from
the search result the agent was shown. `available_modifiers` is deliberately not carried: a spoken
suggestion is not a configurator.

**"Exists" means "the agent actually retrieved it this turn."** `resolveMentionedItems`
(`ordering/mentioned-items.ts`) checks each key against the turn's accumulated `search_results` and
**never falls back to a menu lookup**. A key the agent invented, or recalled from an earlier turn
without re-searching (which the prompt's CONTEXT RULES forbid), is exactly the hallucination the
check exists to catch — a lookup would launder it into a verified item. An unresolved key is
dropped with an `order.mentioned_item_unresolved` warn; it is never a tool error, so a
`propose_cart` naming a bad key still commits its operations. The turn degrades to speech with no
cards, which is the pre-feature behavior.

**One shape, one parser.** `parseAgentReply(obj)` holds the `reply`/`language`/`mentioned_items`
degrade rules for both terminals; `parseSpokenReply(text)` adds only the text unwrapping the
standalone terminal needs. Items are forced empty when there is no usable `reply` — they exist to
accompany speech.

**Transport.** `mentioned_items` is optional on the `OrderReply` event and on the outbound
`order.reply` WS frame, so an existing client is unaffected. TTS never sees it. Capped at
`LIMITS.maxMentionedItems` (8) as a payload/card-count guard — note a turn accumulates every search
it ran, so the agent may legitimately have seen far more items than one search returns.

**Not recorded to history.** `HistoryTurn` is unchanged: cross-turn history stays compact, and the
"re-search before you reuse a key" rule stays true.
