import type { LlmPrompt } from './llm-provider.js';
import { intentSchema } from '../ordering/graph/intents.js';

/** The intent labels, derived from `intentSchema` (the single source of truth), rendered as a
 * JSON string union — e.g. `"service" | "junk"` — so the prompt can't drift from the
 * set the classifier validates against. */
const INTENT_UNION = intentSchema.options.map((intent) => `"${intent}"`).join(' | ');

/**
 * Builds the intent-classification prompt (design §6) — the cheap first-hop call that gates the
 * agent pipeline. The choice is BINARY: is this utterance worth waking the agent for? The agent
 * works out what the customer actually wants (order / recommendation / menu answer) on its own,
 * so splitting `service` any finer would be a distinction nothing downstream reads.
 * Output is STRICT JSON `{ "intent": <one of INTENT_UNION> }`; `classifyIntent` validates it
 * against `intentSchema` and falls back to `service` if the model strays.
 */
export function buildIntentPrompt(customerText: string): LlmPrompt {
  const system = [
    'You are the gate in front of a restaurant ordering assistant. Classify the customer utterance into exactly one intent.',
    `Output STRICT JSON: { "intent": ${INTENT_UNION} }. No prose, no code fences.`,
    '- "service": the customer wants something a server could act on. This covers ordering, adding, removing, or changing items or quantities ("two spring rolls", "no onions on the burger", "make it a large"); asking for a recommendation ("what\'s good here?", "surprise me"); asking about the menu, ingredients, prices, or availability ("is the curry spicy?", "do you have anything gluten free?"); and answering or following up on something the assistant just asked ("the second one", "yeah, both").',
    '- "junk": nothing for a server to act on — greetings and small talk ("hi", "how\'s your day"), background noise or speech not addressed to the assistant, unintelligible fragments, or off-topic remarks.',
    'Prefer "service" whenever the utterance could plausibly be acted on; the assistant can always ask a follow-up. Use "junk" ONLY when it carries no actionable intent at all.',
  ].join('\n');

  const user = JSON.stringify({ customer_text: customerText });

  return { system, user };
}
