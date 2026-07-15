---
type: Concept
title: LLM Provider
description: Provider abstraction (complete + tool-calling chat) + agent/intent prompt builders.
resource: src/llm
timestamp: 2026-07-13
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
  Candidates are NOT pre-fetched — the agent retrieves them via `search_menu_semantic`.
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

## Dependencies
- `ordering/schemas/order-graph-input` + `cart-operation` (prompt-facing types + allowed ops).
  `config/env` for provider selection.

## Key files
- `llm-provider.ts` — `LlmProvider` (`complete` + `chat`) + `LlmPrompt`; tool-calling types
  (`ToolSpec`, `ToolCall`, `AgentMessage`, `ChatResult`).
- `agent-prompt-builder.ts` — `buildAgentMessages`/`buildAgentSystemPrompt` (the agent loop).
- `intent-prompt-builder.ts` — `buildIntentPrompt` (the classifier).
- `llm-client.ts` — `createLlmProvider` switch + `StubLlmProvider` (`complete` yields a
  non-intent JSON that degrades to `service`; `chat` replays an optional scripted `ChatResult[]`
  for deterministic agent-loop tests).
- `openai-compatible-provider.ts` — `OpenAiCompatibleLlmProvider` (Ollama/OpenAI/…),
  `complete` + `chat`.
