import type { LlmPrompt } from './llm-provider.js';
import { intentSchema } from '../ordering/graph/intents.js';

/** The intent labels, derived from `intentSchema` (the single source of truth), rendered as a
 * JSON string union — e.g. `"order" | "suggest" | "junk"` — so the prompt can't drift from the
 * set the classifier validates against. */
const INTENT_UNION = intentSchema.options.map((intent) => `"${intent}"`).join(' | ');

/**
 * Builds the intent-classification prompt (design §6) — the cheap first-hop call that labels
 * an utterance so the graph can route it. Output is STRICT JSON `{ "intent": <one of
 * INTENT_UNION> }`; `classifyIntent` validates it against `intentSchema` and falls back
 * to `order` if the model strays.
 */
export function buildIntentPrompt(customerText: string): LlmPrompt {
  const system = [
    'You classify a restaurant customer utterance into exactly one intent.',
    `Output STRICT JSON: { "intent": ${INTENT_UNION} }. No prose, no code fences.`,
    '- "order": the customer wants to add, remove, or change items or quantities in their order (e.g. "two spring rolls", "no onions on the burger", "make it a large").',
    '- "suggest": the customer wants a recommendation or does not know what to get (e.g. "what\'s good here?", "what do you recommend?", "surprise me").',
    '- "junk": anything not actionable as an order or a request for suggestions — greetings, small talk, background noise, unintelligible fragments, or off-topic remarks.',
    'When unsure between "order" and "suggest", prefer "order". Only use "junk" when the utterance carries no orderable intent at all.',
  ].join('\n');

  const user = JSON.stringify({ customer_text: customerText });

  return { system, user };
}
