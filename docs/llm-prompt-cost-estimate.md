# LLM Prompt & Cost Estimate — Ordering Session

Token and dollar-cost analysis of the prompts the ordering pipeline sends to the LLM,
measured over a representative **5-turn** session.

- **Source of truth:** produced by `scripts/estimate-prompt-tokens.ts`, which runs the real
  prompt builders (`buildIntentPrompt`, `buildAgentSystemPrompt`, `buildAgentUserMessage`) and
  the real `TOOL_SPECS`. Re-run it to regenerate these numbers.
- **Tokenizer:** o200k_base (GPT-4o / 4.1 / o-series). Groq/Llama and Gemini tokenize
  differently (±10–20%).
- **Counts are content-only** — real billing adds ~3–4 tok/message envelope + tool-schema
  formatting overhead (figure **+5–8%**).
- **`search_menu` results are illustrative** — real sizes depend on the live menu DB; the
  shapes are accurate.

## How a turn talks to the LLM

Each turn makes up to two kinds of model call (see `src/ordering/graph/build-graph.ts`):

| Call | Builder | Provider method | When |
|------|---------|-----------------|------|
| **Intent gate** | `buildIntentPrompt` (`src/llm/intent-prompt-builder.ts`) | `complete()` → `{intent}` | Every turn, **except** skipped (forced `service`) when the previous turn ended in an `agent_reply` (`build-graph.ts:74`) |
| **Agent** | `buildAgentMessages` (`src/llm/agent-prompt-builder.ts`) | `chat(messages, TOOL_SPECS)` | Only for `service`; `junk` short-circuits to END |

The agent is a **loop**: every `chat()` step re-sends the entire accumulated `agent_messages`
array, so the fixed system-prompt + tools overhead is billed **once per step**.

## Constants re-sent on every agent `chat()` step

| Payload | Tokens | Chars |
|---|---:|---:|
| Agent system prompt (`buildAgentSystemPrompt`) | 2,230 | 9,748 |
| `tools` array (both function defs, on the wire) | 666 | 2,890 |
| **Fixed agent overhead per step** | **2,896** | — |

~900 of the system-prompt tokens are the `propose_cart` JSON Schema; the `tools` array adds
another 666.

## Per-payload tokens

| Payload | Tokens |
|---|---:|
| T1 intent | 249 |
| T1 agent user | 63 |
| T1 search result | 55 |
| T2 intent | 249 |
| T2 agent user | 183 |
| T2 popularity search result | 112 |
| T3 intent | *skipped* |
| T3 agent user | 220 |
| T3 search result | 51 |
| T4 intent | 251 |
| T4 agent user | 336 |
| T5 intent | 254 |
| T5 agent | *none (junk)* |

## Input (prompt) tokens billed per turn

Each agent step re-sends `system + tools + full scratchpad`, so a 2-call turn (search → propose)
pays the 2,896 overhead **twice**.

| Turn | Shape | Intent | Agent (all chat steps) | Turn total |
|---|---|---:|---:|---:|
| 1 | search → propose (2 calls) | 249 | 6,013 | **6,262** |
| 2 | search → spoken reply (2 calls) | 249 | 6,310 | **6,559** |
| 3 | search → propose, **intent skipped** | 0 | 6,323 | **6,323** |
| 4 | propose directly, no search (1 call) | 251 | 3,232 | **3,483** |
| 5 | junk → short-circuit, no agent | 254 | 0 | **254** |
| | | | **5-turn total** | **≈ 22,881 input tok** |

Output/completion tokens are billed separately (~20–120 tok per agent step).

## Cost @ $0.10/M input, $0.40/M output

### Input (dominant cost)

| | Tokens | Cost |
|---|---:|---:|
| Content-only (measured) | 22,881 | $0.0022881 |
| +7% envelope/tool overhead | ≈24,483 | $0.0024483 |

### Output (estimated)

| Source | ~Tokens |
|---|---:|
| 4 intent replies (`{"intent":"service"}` ≈ 7 tok) | ~28 |
| T1 search + propose calls | ~70 |
| T2 search + spoken reply | ~60 |
| T3 search + propose calls | ~70 |
| T4 propose call | ~50 |
| **Total output** | **≈ 280** → **$0.000112** |

### Per-session total

**≈ $0.0024 – $0.0026 per 5-turn session** (~$0.0025). Input is ~95%; output is negligible.

| Sessions | Cost |
|---|---:|
| 1,000 | ~$2.40 – $2.60 |
| 10,000 | ~$24 – $26 |
| 100,000 | ~$240 – $260 |
| 1,000,000 | ~$2,400 – $2,600 |

## The big lever: prompt caching

The **2,896-tok fixed prefix** (system prompt + tools) is re-sent on every agent `chat()`
step — ~7 steps this session = **~20,300 tok, i.e. ~89% of all input**. If the provider
supports prompt caching on that stable prefix (cache reads typically ~10% of input price),
session input drops from ~$0.0023 to roughly **$0.0004–0.0006** — cutting total session cost by
**~70–80%**. This is the single highest-leverage optimization, far more than trimming the JSON
schema (~900 tok) or history.

## Caveats

- Tokenizer is o200k_base (matches OpenAI-tier pricing); other providers differ ±10–20%.
- `search_menu` result sizes are illustrative; more menu matches → larger tool results
  re-sent each step, amplified by the fixed-overhead multiplier.
- Step count varies with `LIMITS.maxAgentSteps`: extra searches or a retried `propose_cart`
  re-send the 2,896 overhead once more each.

## Reproduce

```
npm i --no-save gpt-tokenizer        # tokenizer is not a project dependency
npx tsx scripts/estimate-prompt-tokens.ts [outFile]   # verbatim payloads → outFile
```
