# Plan: LLM emits the language code (replace STT-detected language for TTS)

## Context / why

TTS speaks the agent's spoken replies (`order.reply`) in the customer's language. Today the
language rides from AssemblyAI STT's `turn.language_code`, but that value is unreliable: the
default streaming model returns `en` for everything, and the multilingual/pro models require a
different model tier / account entitlement that isn't reliably in effect. Result: TTS always
falls back to `TTS_LANGUAGE` (English).

**Pivot:** the agent LLM *writes* the reply, so it knows exactly what language the reply is in.
Have the agent output an ISO-639-1 language code alongside its spoken reply, and use that as the
language on `order.reply`. This is always fresh (the agent runs every turn) and needs no STT model
changes.

**Decided design (do not re-litigate):** reuse the **existing reply route** — the agent still
ends a spoken turn with a no-tool-call assistant message; we just make that message strict JSON
`{"reply": "...", "language": "..."}` and parse it. Do NOT add a new `reply` tool. Do NOT touch
`tool-specs.ts`, `run-tools.ts`, or the graph edges.

Then: **set `e.language` from the agent-provided value** so the existing `order.reply` emit (which
already reads `e.language`) needs no structural change.

## Data flow (target)

```
agent node (no tool call) → res.text is JSON {reply, language}
  → parse → state.reply = reply, state.language = language   (lww overwrite of the STT seed)
  → OrderGraph.interpret → { status:'reply', reply, language }
  → OrderUnderstandingService.dispatch: e.language = result.language
  → bus.emit('order.reply', { ..., language: e.language })    (UNCHANGED emit)
  → RealtimeGateway → TtsService.speak(..., language)          (UNCHANGED)
  → toCartesiaLanguage(language) → Cartesia                    (UNCHANGED)
```

STT-detected `language` stays plumbed as a **fallback** (it seeds `state.language` at graph start;
the agent overwrites it when it provides one). Do not rip STT language out.

---

## Changes (4 files + 1 new pure module + tests + docs)

### 1. `src/llm/agent-prompt-builder.ts` — instruct the JSON reply format

In `buildAgentSystemPrompt()`, the spoken-reply instruction currently says to reply with a plain
spoken message (lines ~59-65) and the multilingual lines are at ~82-83. Update the reply
instruction so that when the agent ends the turn by speaking (no tool call) it outputs STRICT JSON.

- In the WORKFLOW bullet for the spoken-reply branch (the `- Otherwise, REPLY ...` line ~61-63),
  change it to say the reply must be emitted as strict JSON, no prose outside it, no code fences:

  ```
  '   - Otherwise, end the turn by SPEAKING: DO NOT call any tool, and output STRICT JSON',
  '     (no prose outside it, no code fences): {"reply": <the spoken message to the customer>,',
  '     "language": <ISO-639-1 code of the reply language, e.g. "en", "zh", "es", "fr">}.',
  '     Use a spoken reply to ask a clarifying question when ambiguous, or to recommend items.',
  '     The "reply" text is spoken to the customer and ends the turn.',
  ```

- Keep the existing multilingual guidance lines (82-83): "phrase clarifications and recommendations
  in the same language" and "use the language from the latest turn". Add one line tying it to the
  new field:

  ```
  'Set "language" to the language you actually wrote "reply" in (match the customer\'s language).',
  ```

- Update the `propose_cart` guidance / "Never both propose and reply" line so it's clear the JSON
  reply is ONLY for the spoken branch — a committing turn still calls `propose_cart` as a tool and
  outputs no JSON reply. The line ~64-65 ("Always end with either a propose_cart call or a spoken
  reply — never an empty message") stays valid; just make sure "spoken reply" now means the JSON.

- Update the function's doc comment (lines ~42-48) which says the agent "ends the turn ... by
  simply REPLYING with a spoken message (no tool call)" — note it's now a JSON `{reply, language}`.

Leave `buildAgentUserMessage` as-is (it still passes `language: ctx.language` as a hint — harmless).

### 2. NEW `src/ordering/graph/parse-spoken-reply.ts` — pure, unit-testable parser

Mirror the codebase's pattern of extracting pure functions for testing (cf. `normalizeTranscript`,
`mergeHistory`). Robust degradation is the whole point.

**Decided: plain checks, NOT a zod schema (do not re-litigate).** Zod is used elsewhere at LLM
boundaries (`run-tools.ts`, `order-graph-output.schema.ts`, `intents.ts`), but every one of those
feeds `formatZodError()` into a schema-repair prompt — the error message is the payoff. Here the
error is discarded (a miss just degrades), so the machinery buys nothing over two `typeof` checks.
Worse, a `z.object` fails **all-or-nothing**: a bad `language` would invalidate a perfectly good
`reply` and send us down the raw-text path, reading the JSON blob aloud. This module's contract is
**per-field** degradation — a bad `language` must never cost us the `reply`.

```ts
import type { LangCode } from '../../shared/types.js';

/** Parsed spoken-reply terminal. `reply` is null when the agent said nothing usable. */
export interface SpokenReply {
  reply: string | null;
  language?: LangCode;
}

/** ISO-639-1/2 primary subtag, optional region (`en`, `zh`, `yue`, `pt-BR`). */
const LANG_RE = /^[a-z]{2,3}([-_][a-z]{2,4})?$/i;

/**
 * The agent ends a spoken turn with strict JSON {"reply": "...", "language": "..."} (see
 * agent-prompt-builder). Parse it, DEGRADING PER-FIELD: text that isn't JSON is spoken as-is (never
 * drop a reply); a JSON blob with no usable "reply" is a degenerate terminal (never read JSON
 * aloud); an off-format "language" costs only the language, and TTS falls back to TTS_LANGUAGE.
 */
export function parseSpokenReply(raw: string | undefined): SpokenReply {
  let text = raw?.trim();
  if (!text) return { reply: null };

  // Tolerate a ```json ... ``` fence even though the prompt forbids it.
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1].trim();

  if (text.startsWith('{')) {
    let obj: { reply?: unknown; language?: unknown };
    try {
      obj = JSON.parse(text);
    } catch {
      return { reply: text }; // Not JSON after all (e.g. truncated) — speak it rather than drop it.
    }
    // It parsed, so the raw text IS a JSON blob and is never speakable: `reply` or nothing.
    const reply = typeof obj.reply === 'string' && obj.reply.trim() ? obj.reply : null;
    if (reply === null) return { reply: null };
    const lang = typeof obj.language === 'string' ? obj.language.trim() : '';
    // An off-format code ("Chinese") degrades to no language, not garbage forwarded to Cartesia.
    return LANG_RE.test(lang) ? { reply, language: lang.toLowerCase() as LangCode } : { reply };
  }
  return { reply: text };
}
```

Two guards here are load-bearing and easy to lose in review:

1. **`language` is shape-checked.** `LangCode` is a bare `string` alias (`shared/types.ts:24`), so
   TypeScript offers no protection; without `LANG_RE`, an agent that emits `"Chinese"` sends
   `toCartesiaLanguage()` → `"chinese"` straight to Cartesia as a language param.
2. **Fall-through-to-raw only fires when `JSON.parse` THREW.** If it parsed and carried no `reply`,
   the raw text is a JSON blob with no spoken content — `{reply: null}` (→ `agent_no_terminal`) is
   the honest outcome, and that failure path already exists today for empty text.

Add `src/ordering/graph/parse-spoken-reply.test.ts` covering:
- strict JSON → `{reply, language}`
- JSON with only `reply` → `{reply}` (no language)
- fenced JSON (```json) → parsed
- plain text (no braces) → `{reply: text}`, no language
- malformed/truncated JSON starting with `{` → `{reply: rawText}` (degrade — speak it)
- empty / whitespace / undefined → `{reply: null}`
- valid JSON missing/blank `reply` (`{"language":"en"}`) → `{reply: null}` (degenerate terminal —
  do NOT speak the blob)
- valid JSON with an off-format `language` (`{"reply":"hi","language":"Chinese"}`) → `{reply: 'hi'}`,
  no language (per-field degrade: the reply survives)
- `language` is normalized (`{"reply":"hi","language":"ZH-CN"}`) → `{reply: 'hi', language: 'zh-cn'}`

### 3. `src/ordering/graph/build-graph.ts` — parse in the agent node's no-tool-call branch

Add import:
```ts
import { parseSpokenReply } from './parse-spoken-reply.js';
```

In the `agent` node (lines ~84-103), replace the no-tool-call branch (currently ~98-101):

```ts
      // No tool call → the agent ended the turn by speaking. The reply is strict JSON
      // {reply, language}; parse it and record the language onto state (lww overwrites the STT
      // seed). Non-JSON text degrades to being spoken as-is with no language; a blob with no
      // usable reply is the same degenerate terminal as empty text was.
      if (res.toolCalls.length === 0) {
        const { reply, language } = parseSpokenReply(res.text);
        if (reply === null) return { ...base, failure_reason: 'agent_no_terminal' };
        return { ...base, reply, ...(language !== undefined ? { language } : {}) };
      }
      return base;
```

Note: `finalize` (lines ~109-116) records `s.reply` as `agent_reply` in history — this is now the
CLEAN parsed reply text (not the JSON), which is correct: history should carry the spoken words.

### 4. `src/ordering/order-graph.ts` — carry `language` out of the graph

- `InvokeReturn` (lines ~33-39): add `language?: LangCode;` (read from final state).
  ```ts
  type InvokeReturn = {
    intent: Intent;
    output: OrderGraphOutput | null;
    base_version: number;
    reply: string | null;
    language?: LangCode;
    failure_reason: string | undefined;
  };
  ```
- `GraphTurnResult` reply variant (line ~29): add optional language.
  ```ts
  | { status: 'reply'; reply: string; language?: LangCode }
  ```
- `interpret()` (line ~81): include it.
  ```ts
  if (out.reply !== null) {
    return { status: 'reply', reply: out.reply, ...(out.language !== undefined ? { language: out.language } : {}) };
  }
  ```
`LangCode` is already imported (line 1).

### 5. `src/ordering/order-understanding-service.ts` — set `e.language` from the agent value

In `dispatch()`, `case 'reply'` (lines ~74-85): before the emit, override `e.language` with the
agent-provided language when present, then keep the existing emit unchanged.

```ts
      case 'reply':
        // The agent declares the language it wrote the reply in; prefer it over the STT-detected
        // language so TTS speaks the reply in its actual language. Falls back to e.language
        // (STT) when the agent didn't provide one.
        if (result.language !== undefined) e.language = result.language;
        this.bus.emit('order.reply', {
          cart_id: e.cart_id,
          session_id: e.session_id,
          request_id: e.request_id,
          reply: result.reply,
          ...(e.language !== undefined ? { language: e.language } : {}),
        });
        return;
```

(`result` is narrowed to the `reply` variant here, so `result.language` is available.)

No change needed to `events/event-types.ts` (`OrderReply.language` already exists) or to
`realtime-gateway.ts` / `tts/*` (all already forward `language`).

---

## Out of scope / leave alone

- **Do NOT** add a `reply` tool or change `tool-specs.ts`, `run-tools.ts`, or graph edges.
- **Do NOT** rip out STT language plumbing — it remains the fallback (`e.language` seed). The
  `src/stt/assemblyai-stt-provider.ts` experiment (`speechModel`, `languageCodes`, the `console.log`
  diagnostic) is the user's separate WIP; do not touch it unless the user asks.
- Language-code FORMAT: the agent emits ISO-639-1 (`en`, `zh`). `toCartesiaLanguage()` already
  lowercases the primary subtag, so this is TTS-safe. `LangCode` is a bare `string` alias, so no
  type friction — and no type-level guard either, which is why `parse-spoken-reply.ts` shape-checks
  the value with `LANG_RE` rather than trusting it. (Note: menu-name lookups key on Odoo `res.lang`
  like `en_US`; that's unrelated to this change and unaffected.)
- **Do NOT** reach for a zod schema in `parse-spoken-reply.ts` — see the rationale in §2. Zod
  elsewhere in the repo exists to feed schema-repair prompts; this parser degrades instead of
  repairing, and needs per-field (not all-or-nothing) failure.

## Verification

1. `npx tsc -p tsconfig.json --noEmit` — clean.
2. `npx vitest run` (unit) — all pass; new `parse-spoken-reply.test.ts` passes. Check for existing
   tests that assert on the reply mechanism and update expectations:
   - `grep -rn "reply" src/ordering/**/*.test.ts src/llm/*.test.ts`
   - any test that feeds a fake LLM a plain-text reply and expects `status:'reply'` must now feed
     JSON `{"reply":"...","language":"..."}` OR rely on the plain-text degrade path (still yields
     `status:'reply'` with no language — both are valid; pick per the test's intent).
3. Manual: run the app, speak a non-English utterance that triggers a clarifying question /
   recommendation, confirm the spoken reply is in that language (Cartesia) and that `order.reply`
   carries the right `language`.

## Knowledge base / docs (same PR, per CLAUDE.md)

- `.claude/.knowledge/log.md` — add a top entry (newest first):
  ```
  ## 2026-07-14 — Agent emits the reply language (replaces STT-detected language for TTS)
  - **What:** The ordering agent now ends a spoken turn with strict JSON {reply, language}; the
    parsed ISO-639-1 language sets order.reply.language (via e.language) → TTS. New pure
    parse-spoken-reply.ts (+test). STT-detected language stays as a fallback seed.
  - **Why:** STT language_code was unreliable (default AssemblyAI streaming model returns en); the
    agent that writes the reply knows its language, so TTS now speaks replies in the right language.
  - **Where:** llm (agent-prompt-builder), ordering (build-graph, order-graph,
    order-understanding-service, graph/parse-spoken-reply), events flow unchanged.
  ```
- `docs/agent-tools.md` §3 — update: the spoken-reply outcome is now JSON `{reply, language}`, not
  bare text. Keep the "reply is not a tool" framing (it's still a no-tool-call terminal).
- `docs/text-to-speech.md` §Multilingual — update: the reply's language now comes from the agent's
  reply JSON (`order.reply.language`), not the STT-detected turn language; STT language is a
  fallback. `toCartesiaLanguage()` behavior unchanged.
- `.claude/.knowledge/llm/overview.md` and `.claude/.knowledge/ordering/overview.md` — if either
  describes the reply mechanism as plain text, update to JSON `{reply, language}`. Skip if they
  don't mention it.

## Key file/line anchors (as of this plan)

- `src/llm/agent-prompt-builder.ts:50` `buildAgentSystemPrompt`; reply instruction ~59-65;
  multilingual lines ~82-83.
- `src/ordering/graph/build-graph.ts:84` `agent` node; no-tool-call branch ~98-101; `finalize` ~109.
- `src/ordering/graph/state.ts:50` `language: lww<LangCode | undefined>` (already exists; the agent
  node writes it).
- `src/ordering/order-graph.ts:27` `GraphTurnResult`; `InvokeReturn` ~33-39; `interpret` ~74-84.
- `src/ordering/order-understanding-service.ts:74` `case 'reply'`.
- `src/events/event-types.ts:40` `OrderReply.language` (already exists).
- `src/tts/tts-service.ts` / `src/tts/cartesia-tts-provider.ts` — consumers, unchanged.
</content>
</invoke>
