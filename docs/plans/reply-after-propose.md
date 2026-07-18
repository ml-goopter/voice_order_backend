# Plan — Let the agent reply *and* propose in the same turn

## Goal

Today an ordering turn ends **exactly one way**: a validated `propose_cart` (`output`) **or** a
spoken `order.reply`, never both (LLM-graph.md invariant #5, `output`/`reply` mutually exclusive).
We want the agent to be able to **speak a confirmation while proposing** — e.g. propose two lattes
*and* say "Added two lattes, anything else?" in the same turn.

Verifiable definition of done: a single customer turn can cause the ordering module to emit **both**
`order.operations_proposed` **and** `order.reply`, and existing propose-only / reply-only turns are
unchanged.

---

## Design decision (read first)

There are two ways to let a turn both propose and speak. **We take approach B.**

**Approach A — reply as a separate terminal step.** Make `propose_cart` non-terminal: after it
validates, loop back to `agent`, which then speaks a reply as the sole terminal. Costs an **extra
LLM round-trip on every confirming turn** (latency on a voice path), and reintroduces the
`interpret()` precedence trap (a follow-up reply that fails would set `agent_no_terminal` *alongside*
a valid `output`, risking a dropped proposal). Rejected.

**Approach B — bundle an optional `reply` into the `propose_cart` call. ✅ Recommended.**
`propose_cart` stays a terminal action but gains two optional args, `reply` and `language`. When
present, the `tools` node sets `output` **and** the `reply`/`reply_language` channels from the one
call. No graph-edge change, no extra LLM call, no precedence trap. The agent knows exactly what it
proposed, so bundling loses no information (cart-module validation is downstream of the graph in
*either* approach, so a separate step gains no rejection insight either).

Everything below implements **approach B**.

> Note: this supersedes the "make `propose_cart` non-terminal" framing from the initial discussion —
> bundling is strictly simpler and cheaper.

**Reevaluation under the "propose is always the last tool call" requirement.** The requirement that
a turn with something to commit must finish with `propose_cart`, carrying any spoken suggestion in
its **reply field**, does not merely favour B — it **eliminates A**. A's speech is a *separate*
standalone reply emitted *after* `propose_cart`; A's proposal has no reply field, so "put the
suggestion in the order proposal's reply field" is literally unrepresentable in A. The requirement
is, in effect, a description of B. (It also happens to be the cheaper path — B keeps the whole
"commit + speak" turn to a single terminal call with no extra LLM round-trip.) **Decision stands: B.**

Consequence for the prompt: the model must gather everything it needs (all `search_menu` calls)
*before* the terminal `propose_cart`, because that call is where both the operations and the words
are emitted — see §5's ordering rule.

---

## Change surface (file by file)

### 1. `propose_cart` tool schema — advertise the optional reply
`src/ordering/tools/tool-specs.ts` — add `reply` and `language` to `propose_cart.parameters`
(both optional; `operations` stays the only required field). Update the tool `description` to say a
short spoken confirmation may accompany the operations.

- Verify: `TOOL_SPECS` still has `required: ['operations']`; typecheck passes.

### 2. `run-tools` — capture the bundled reply
`src/ordering/tools/run-tools.ts`:
- Extend `ToolExecResult` with optional `reply?: string` and `reply_language?: LangCode`.
- In the `propose` branch, after the existing operations validation (keep the empty-array
  rejection unchanged), read `argsObj.reply` / `argsObj.language`:
  - `reply` = `argsObj.reply` when it is a non-empty trimmed string, else omitted (an empty/blank
    reply is treated as "no confirmation", not an error).
  - `language` = validate as an ISO code the same way the spoken path does; omit if malformed
    (degrade to the TTS default downstream, matching `parse-spoken-reply`).
- In `runTools`, thread `res.reply` / `res.reply_language` into the returned state patch (alongside
  `output`). Only include the channels when set (so `lww` leaves them cleared otherwise).

- Verify (new unit test `run-tools.test.ts`, see Tests): a `propose_cart` with `reply` sets
  `output` **and** `reply`; with a blank `reply` sets `output` only; a bad `language` drops the
  language but keeps `reply`.

### 3. `interpret()` — surface both on a `complete`
`src/ordering/order-graph.ts`:
- Widen the `complete` variant of `GraphTurnResult`:
  ```ts
  | { status: 'complete'; output: OrderGraphOutput; base_version: number; reply?: string; language?: LangCode }
  ```
- In `interpret()`, the `output !== null` branch now also carries the reply when the channels are
  set:
  ```ts
  if (out.output !== null) {
    const lang = out.reply_language;
    return {
      status: 'complete',
      output: out.output,
      base_version: out.base_version,
      ...(out.reply !== null ? { reply: out.reply } : {}),
      ...(out.reply !== null && lang !== undefined ? { language: lang } : {}),
    };
  }
  ```
  The `output`-before-`reply` check order is unchanged and correct: in approach B `output` and
  `reply` are written by the **same** terminal `propose_cart`, so both being set means "propose +
  confirm", and the standalone-`reply` branch still handles clarify/recommend.
- `failure_reason` cannot co-occur with `output` in approach B (no loop after propose), so the
  existing `failure_reason`-first check needs no change.

- Verify: typecheck; service tests below.

### 4. Service dispatch — emit both events
`src/ordering/order-understanding-service.ts`, `dispatch()` `case 'complete'`:
- Call `this.propose(e, result)` as today, then, when `result.reply` is present, also
  `this.bus.emit('order.reply', {...})` with `language: result.language ?? config.ttsLanguage`
  (identical shape to the existing `'reply'` case).
- Extract the reply emission into a small private helper reused by both the `'reply'` and
  `'complete'` cases to avoid duplication.
- Ordering: emit `order.operations_proposed` **first**, then `order.reply` (cart update before the
  spoken confirmation). Both are fire-and-forget — see Risk 1.

- Verify: service test asserting both events fire for one transcript, with the proposal carrying the
  operations and the reply carrying the confirmation text + defaulted language.

### 5. Prompt — permit the bundled reply AND make `propose_cart` the last tool call
`src/llm/agent-prompt-builder.ts`:
- Delete the `'Never both propose and reply in the same turn: …'` sentence (currently the 3 lines
  ending "never an empty message." — keep the "never an empty message" guidance, drop the mutual
  exclusion clause).
- In WORKFLOW step 2, document that `propose_cart` MAY include a short spoken `reply` (one friendly
  sentence, e.g. "Added two lattes — anything else?") plus its `language` (ISO code, **chosen before
  writing `reply`**, same rule as the standalone path). Standalone spoken reply (no tool) stays the
  path for clarify/recommend when there is nothing to commit.
- Keep the PRICE RULES intact — a confirmation must not read totals/subtotals (the agent still can't
  see line/cart totals).

**The ordering rule (new, load-bearing).** Add an explicit rule that when a turn has anything to
commit, **the turn MUST end with `propose_cart`, and any words to speak go in its `reply` field** —
never a standalone spoken reply that would drop the commit, and never a proposal followed by silence
when the customer also asked to be advised. `propose_cart` is therefore always the **last** tool
call: do every `search_menu` first, then finish with the single `propose_cart` that carries both the
operations and the spoken reply.

Worked example to embed in the prompt (the case that motivated this):

> "add beef jerky then suggest some items" — the customer wants a commit **and** advice in one turn.
> Do NOT reply with the suggestion first (that ends the turn and drops the beef jerky), and do NOT
> propose the beef jerky silently (that drops the suggestion). Instead: `search_menu` for beef
> jerky, `search_menu` for suggestion candidates, then **one** `propose_cart` with
> `operations:[add beef jerky]` and `reply:"Added beef jerky — you might also like <X> or <Y>."`

Spell out the decision the model must make:
- Something to commit **and** nothing to say → `propose_cart`, no `reply`.
- Something to commit **and** something to say (confirm / suggest / a *non-blocking* remark) →
  `propose_cart` with `operations` + `reply`.
- Nothing to commit (need a *blocking* answer before acting, or a pure recommendation with no add) →
  standalone spoken reply, no `propose_cart`.

- Verify: prompt unit assertions if any exist (grep for existing prompt snapshot tests); otherwise
  manual review + the behavioral service tests (including the beef-jerky case below).

### 6. State + graph docs/comments
- `src/ordering/graph/state.ts`: update the `output`/`reply` comment block — they are **no longer
  mutually exclusive**; a `propose_cart` may set both. `normalize` still clears both (unchanged).
- `src/ordering/graph/build-graph.ts`: the `tools → finalize` edge and `agent → finalize` edge are
  **unchanged** (propose_cart stays terminal). Update the header comment that says the agent "ends
  the turn either by committing operations *or* by replying" to note operations may carry a spoken
  confirmation.

- Verify: typecheck; no edge logic changed, so graph routing tests stay green.

---

## Behavioral implications to confirm

1. **`finalize` records `agent_reply` whenever `reply` is set** (build-graph.ts lines ~123-130),
   so a propose+confirm turn writes the confirmation into `history` and thereby triggers
   `classify`'s **pending-reply override** on the *next* turn (force `service`, skip the junk gate).
   For a mere confirmation ("Added two lattes") that is mildly wasteful (a following "thanks" gets
   force-serviced instead of dropped as junk) but **safe**. **Recommendation: keep as-is** (the
   confirmation is also useful history context). Flagging because it is a behavior change; if
   undesired, gate the override so it only fires for standalone replies.

2. **CLAUDE.md ordering requirement** states the module turns a transcript into "either an
   `OrderProposal` … **or** a spoken `order.reply`". This line must change to "… and/or …". This is
   a checked-in contract, so update it deliberately.

---

## Risks

1. **Confirmation can outrun/contradict cart validation.** The graph is a pure proposer; the cart
   module re-validates each op and may reject some (`cart.operation_rejected`). A spoken "Added two
   lattes" is emitted fire-and-forget and could contradict a partial rejection. This already exists
   in spirit (reply and cart updates are independent) and is acceptable for v1; the mitigation
   (speak only after cart confirms) is explicitly out of scope. Note it in the docs.
2. **Language drift inside tool args.** The generation-order rationale for "language first" in
   `parse-spoken-reply` applies to free text; inside a tool call the model emits JSON args and may
   place `reply` after a long `operations` array. Mitigation: prompt instructs choosing `language`
   before writing `reply`; best-effort, and a bad code merely falls back to `TTS_LANGUAGE`.

---

## Tests

Add / update, then run `npm test` and `npm run typecheck` (typecheck tests separately per repo
convention).

- **`src/ordering/tools/run-tools.test.ts` (new).**
  - `propose_cart` with `operations` + `reply` + `language` → patch has `output`, `reply`,
    `reply_language`.
  - blank/whitespace `reply` → `output` set, `reply` omitted.
  - malformed `language` → `reply` set, `reply_language` omitted.
  - empty `operations` still rejected as a retriable tool error (regression).
- **`src/ordering/order-understanding-service.test.ts`.**
  - New `propose` helper variant that includes `reply`/`language` in the tool args (mirror the
    existing `propose(operations)` at line 48).
  - New case: one transcript whose agent calls `propose_cart` with a confirmation → **both**
    `order.operations_proposed` and `order.reply` collected; proposal has the ops, reply has the
    text and `language` (defaulted to `config.ttsLanguage` when omitted).
  - **Beef-jerky ordering case:** script a turn as `search` (jerky) → `search` (suggestions) →
    `propose_cart({operations, reply})`. Assert `propose_cart` is the **last** scripted call, that
    both events fire, and that the reply carries the suggestion text. This is the regression guard
    for the "propose is always the last tool call" rule.
  - Regression: existing propose-only and reply-only cases stay green (mutual-exclusion tests, if
    any assert "no reply when proposing", must be updated to the new contract).
- **`src/ordering/graph/state.test.ts`.** If anything asserts output/reply mutual exclusion, update
  it.

Each step's verification is a passing test or a green typecheck — no "make it work" goals.

---

## Docs / knowledge base (required by repo skills)

- `docs/LLM-graph.md`: invariant #5 (drop mutual exclusion → "a `propose_cart` may also set
  `reply`"), §5.3 "two terminals" (note the bundled confirmation), §7 outcome table (`complete` may
  carry a reply), the channel table note on `output`/`reply`.
- `docs/agent-tools.md`: the workflow description (propose may confirm).
- `.claude/.knowledge/ordering/*`: run the **knowledge-base-maintenance** skill after the change.
- `CLAUDE.md`: the ordering requirement line (see implication #2).

---

## Rollout order (small logical commits)

1. Schema + `run-tools` (mechanism, with `run-tools.test.ts`) — no behavior visible yet.
2. `interpret()` + `GraphTurnResult` + service `dispatch` (+ service test) — events now flow.
3. Prompt change — agent starts using it.
4. Comments/state + docs + knowledge base.

Each commit typechecks and tests green on its own.
