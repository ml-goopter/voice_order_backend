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
  `createLlmProvider` selects by config.
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
- `llm-client.ts` — **stub** `StubLlmProvider` (returns a valid empty proposal so
  the pipeline runs). TODO Groq/OpenAI/Gemini with retry + repair prompt +
  schema-validated output (§8/§11.3/§14).
