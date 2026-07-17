---
type: Concept
title: LLM Provider
description: Provider abstraction (complete + tool-calling chat) + agent/intent prompt builders.
resource: src/llm
timestamp: 2026-07-17
---

# LLM Provider

## Purpose
The LLM abstraction behind Order Understanding. Two call shapes: `complete` (single-shot
strict-JSON, used by the intent classifier) and `chat` (native tool-calling, drives the
ordering **agent** — docs/agent-tools.md). It only **proposes**; the Cart Module is the
deterministic source of truth.

## Mechanics
- `LlmProvider` interface: `complete(prompt) → string` (raw JSON text, the parser/
  classifier path) **and** `chat(messages, tools) → { text?, toolCalls }` (native
  tool-calling, drives the agent loop — see `docs/agent-tools.md`).
  `createLlmProvider` selects by `config.llmProvider` (`stub` | `ollama` | `openai`).
- `OpenAiCompatibleLlmProvider` (real): OpenAI SDK against a configurable base URL,
  so one client serves Ollama (default `http://localhost:11434/v1`), OpenAI, Groq.
  Env-driven (`LLM_MODEL`/`LLM_BASE_URL`/`LLM_API_KEY`, and `LLM_TIMEOUT_MS` for the
  per-request timeout — default 30s, raise for slow local thinking models like
  qwen3). `complete` sends system+user messages with `response_format: json_object`,
  `temperature: 0`; SDK handles transient retries.
- `chat` maps the transport-independent `AgentMessage[]` transcript + `ToolSpec[]`
  onto the OpenAI `tools` API (`temperature: 0`, no `response_format`), and parses
  the response's `tool_calls` back into `ToolCall`s with JSON-decoded `arguments`
  (malformed args degrade to `{}` so the tool handler's zod validation rejects them
  as a normal tool error). Only tool-capable models can drive it; the stub scripts it.
  Each parsed `ToolCall` also keeps the SDK's **original tool-call payload** in `raw`;
  when the assistant turn is replayed on the next loop iteration `toOpenAiMessage` sends
  that `raw` back VERBATIM rather than rebuilding it from `id`/`name`/`arguments`. This is
  required for Gemini 3.x: its function calls carry a `thought_signature` that the follow-up
  request must echo unchanged or it 400s. A tool-calls-only assistant turn also omits
  `content` (a null content beside `tool_calls` is rejected by some compat endpoints).
- `agent-prompt-builder.ts` builds the agent's seed transcript: a system message fixing the
  tool workflow (search first, then EITHER `propose_cart` OR a spoken reply emitted as strict
  JSON `{language, reply}`, where `language` is the ISO-639-1 code of the language the agent
  wrote the reply in — parsed by `ordering/graph/parse-spoken-reply.ts` and forwarded to TTS)
  and the operation contract (keys from search results, edits target `line_id`, only `add_item`
  omits it), plus a user message with the utterance, `current_cart`, and `conversation_history`.
  A dedicated **LANGUAGE** section makes `customer_text` the sole authority on which language to
  reply in and requires matching the LATEST utterance (so a mid-conversation switch is honoured;
  history is context for intent, not evidence of language). No language hint is passed in the user
  context — the STT code tags nearly every turn `en`, and a wrong hint is worse than none.
  **`language` is demanded as the FIRST JSON field on purpose.** The model generates left to
  right, so the earlier `{reply, language}` shape let it write the whole reply — drifting into
  `conversation_history`'s language — and only then label what it had written, so `language`
  described the drift instead of preventing it (observed: a zh → zh → en session answered in zh).
  Emitting the code first forces the choice before any reply token exists. The ordering is a
  generation-time device enforced ONLY by the prompt: `parse-spoken-reply.ts` JSON.parses and
  accepts either order, so a model that slips back to reply-first still keeps its language.
  Candidates are NOT pre-fetched — the agent retrieves them via `search_menu`. The prompt's
  WORKFLOW section also teaches that tool's filters/sort (popularity for "what do you
  suggest?", one call for "popular AND <thing>"), that a `popularity` tier may be voiced but
  never a rank or a count, and that the menu carries **no ingredient/allergen/dietary data** —
  so the agent must refuse to guess at an allergy question rather than infer from a name.
  The system prompt also embeds the **JSON Schema for a `propose_cart` operation**, generated
  from `cartOperationSchema` via `z.toJSONSchema` (with a small `scrubSchema` pass to drop the
  sentinel `maximum`/`$schema` noise) so the advertised shape can't drift from validation. The
  schema pins STRUCTURE only; the prose KEY RULES still carry the semantics a schema can't
  express (key provenance, the inline-modifier rule, matching a cart line by name).
- `intent-prompt-builder.ts` builds the junk-gate classifier prompt (`{intent}` JSON). The choice
  is BINARY — `service` (anything a server could act on: ordering, edits, recommendations, menu
  questions) vs `junk` (greetings, small talk, noise, off-topic) — because the agent decides the
  outcome itself, so a finer label would be read by nothing downstream. `service` is defined by
  inclusion, with an explicit "prefer `service` whenever it could plausibly be acted on" tiebreak:
  the gate's only real failure mode is dropping a live order, and the agent can always ask a
  follow-up. The label union renders from `intentSchema.options`, so the prompt can't drift from
  the set the classifier validates against.

- **Usage/cache observability** (`usage.ts`): both `complete` and `chat` capture the SDK's
  `res.usage` (mapped by `usageOf` onto a transport-independent `LlmUsage`). The provider emits one
  `llm.usage` INFO line per call — `kind` (`complete`/`chat`), `provider`, `model`, `elapsed_ms`,
  `prompt_tokens`, `completion_tokens`, `total_tokens`, and (when the provider reports it)
  `cached_tokens` + `cache_hit_rate`. `elapsed_ms` is the wall-clock of the whole `create()` await,
  so it INCLUDES the SDK's transparent retry/backoff (`llmTransportMaxRetries`, 429/5xx) — a call
  that is cheap by token count but slow here was rate-limited, cold, or thinking, not busy (pair it
  with `completion_tokens` to tell reasoning-token burn apart from retry/latency). It is the ONE
  field always emitted: unlike the token/cache fields it is logged even when the provider omits its
  `usage` block, so per-call latency is never lost. When `create()` instead THROWS (retries
  exhausted — timeout, persistent 429/5xx), the provider emits an `llm.call_failed` WARN line with
  the same `kind`/`provider`/`model`/`elapsed_ms` plus a `reason`, then rethrows — so a timed-out
  call shows its cost, which the success-only `llm.usage` line can't capture. Cache detail location varies by provider: `usageOf` prefers OpenAI/Groq's nested
  `prompt_tokens_details.cached_tokens` and falls back to a flat `total_cached_tokens` some compat
  endpoints use. It is OPTIONAL end-to-end: providers that report neither (Ollama, and — verified
  empirically — Gemini's OpenAI-compat `v1beta/openai/` endpoint, which returns only the three basic
  counts) omit the cache fields, so "absent" stays distinct from a genuine 0% (never averaged as a
  fake zero). Cache-hit visibility on Gemini would require its NATIVE API (`cachedContentTokenCount`). `chat` also returns `usage` on `ChatResult` so
  the ordering agent loop can accumulate a per-turn total (`TurnUsage` via `addUsage`) and emit the
  `llm.turn_usage` rollup — see the ordering bundle. `model` is exposed on the `LlmProvider`
  interface so that rollup can attribute cost per model. Raw token COUNTS only; cost is priced
  downstream from a per-model table.

## Dependencies
- `contracts/{cart-view, cart-operation.schema, intent}` (prompt-facing types, allowed ops, intent
  label set) — the prompt builders speak these shared contracts and no longer reach into `ordering`.
  `config/env` for provider selection.

## Key files
- `llm-provider.ts` — `LlmProvider` (`name`, `model`, `complete` + `chat`) + `LlmPrompt`;
  tool-calling types (`ToolSpec`, `ToolCall`, `AgentMessage`, `ChatResult` with optional `usage`).
- `usage.ts` — `LlmUsage`/`TurnUsage` types + pure `addUsage`/`cacheHitRate` (LangGraph-independent,
  unit-tested in `usage.test.ts`).
- `agent-prompt-builder.ts` — `buildAgentMessages`/`buildAgentSystemPrompt` (the agent loop).
- `intent-prompt-builder.ts` — `buildIntentPrompt` (the classifier).
- `llm-client.ts` — `createLlmProvider` switch + `StubLlmProvider` (`complete` yields a
  non-intent JSON that degrades to `service`; `chat` replays an optional scripted `ChatResult[]`
  for deterministic agent-loop tests).
- `openai-compatible-provider.ts` — `OpenAiCompatibleLlmProvider` (Ollama/OpenAI/…),
  `complete` + `chat`; `usageOf` maps `res.usage` and `logUsage` emits the per-call `llm.usage` line.
