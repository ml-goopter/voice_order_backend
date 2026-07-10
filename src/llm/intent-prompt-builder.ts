import type { LlmPrompt } from './llm-provider.js';

/**
 * Builds the intent-classification prompt (design §6) — the cheap first-hop call that labels
 * an utterance so the graph can route it. Output is STRICT JSON `{ "intent": "order" |
 * "suggest" | "junk" }`; `classifyIntent` validates it against `intentSchema` and falls back
 * to `order` if the model strays. Kept in sync with the intent set by convention (the three
 * labels below are the `intentSchema` values).
 */
export function buildIntentPrompt(customerText: string): LlmPrompt {
  const system = [
    'You classify a restaurant customer utterance into exactly one intent.',
    'Output STRICT JSON: { "intent": "order" | "suggest" | "junk" }. No prose, no code fences.',
    '- "order": the customer wants to add, remove, or change items or quantities in their order (e.g. "two spring rolls", "no onions on the burger", "make it a large").',
    '- "suggest": the customer wants a recommendation or does not know what to get (e.g. "what\'s good here?", "what do you recommend?", "surprise me").',
    '- "junk": anything not actionable as an order or a request for suggestions — greetings, small talk, background noise, unintelligible fragments, or off-topic remarks.',
    'When unsure between "order" and "suggest", prefer "order". Only use "junk" when the utterance carries no orderable intent at all.',
  ].join('\n');

  const user = JSON.stringify({ customer_text: customerText });

  return { system, user };
}
