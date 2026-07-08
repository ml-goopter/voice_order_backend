---
type: Concept
title: LLM Parser
description: Provider abstraction + prompt builder producing strict-JSON operations.
resource: src/llm
timestamp: 2026-07-07
---

# LLM Parser

## Purpose
The multilingual parser that converts a transcript into cart operations using
internal menu keys (design §8). It only **proposes**; the Cart Module is the
deterministic source of truth. Output is strict JSON, schema-validated before use.

## Mechanics
- `LlmProvider` interface: `complete(prompt) → string` (raw JSON text).
  `createLlmProvider` selects by `config.llmProvider` (`stub` | `ollama` | `openai`).
- `OpenAiCompatibleLlmProvider` (real): OpenAI SDK against a configurable base URL,
  so one client serves Ollama (default `http://localhost:11434/v1`), OpenAI, Groq.
  Env-driven (`LLM_MODEL`/`LLM_BASE_URL`/`LLM_API_KEY`, and `LLM_TIMEOUT_MS` for the
  per-request timeout — default 30s, raise for slow local thinking models like
  qwen3). Sends system+user messages with `response_format: json_object`,
  `temperature: 0`; SDK handles transient retries.
- `prompt-builder.ts` assembles the prompt from `OrderGraphInput`: a system message
  fixing the output contract and rules (use candidate keys, edits target `line_id`,
  only `add_item` omits it, clarify when ambiguous) and a user message with the
  transcript, current cart, and candidate items. The full menu is never sent.

## Dependencies
- `ordering/schemas/order-graph-input` (prompt input). `config/env` for provider
  selection.

## Key files
- `llm-provider.ts` — `LlmProvider` + `LlmPrompt`.
- `prompt-builder.ts` — `buildPrompt`.
- `llm-client.ts` — `createLlmProvider` switch + `StubLlmProvider` (valid empty
  proposal so the pipeline runs keyless).
- `openai-compatible-provider.ts` — `OpenAiCompatibleLlmProvider` (Ollama/OpenAI/…).
