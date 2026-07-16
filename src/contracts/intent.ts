import { z } from 'zod';

/**
 * The intent classes the classifier assigns to each utterance (design §6). This enum is
 * the SINGLE SOURCE OF TRUTH: the classifier prompt, the classifier's output validation,
 * and the graph's routing table all derive from it.
 *
 * The set is BINARY because that is the only distinction anything downstream acts on. Since the
 * agent rework (docs/agent-tools.md) the agent decides the outcome (propose / ask / recommend)
 * from the utterance itself, so the classifier's only job is the gate:
 *
 * - `service` — the customer wants something a server could act on: ordering, changing or removing
 *               items, a recommendation, a question about the menu.
 * - `junk`    — nothing actionable (greeting, small talk, noise, unintelligible, off-topic).
 *
 * Routing lives with the graph (`ordering/graph/intents.ts` `INTENT_ROUTE`); the contract here is
 * only the label set the classifier prompt and its validation share.
 */
export const intentSchema = z.enum(['service', 'junk']);
export type Intent = z.infer<typeof intentSchema>;

/** Safe fallback: an utterance we cannot classify runs the full agent pipeline, so a real
 * order is never dropped. Also the state channel default before `classify` writes it. */
export const DEFAULT_INTENT: Intent = 'service';
