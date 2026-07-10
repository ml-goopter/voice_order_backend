import { z } from 'zod';

/**
 * The intent classes the classifier assigns to each utterance (design §6). This enum is
 * the SINGLE SOURCE OF TRUTH: the classifier prompt, the classifier's output validation,
 * and the graph's routing table all derive from it.
 *
 * - `order`   — the customer wants to add/remove/change items or quantities.
 * - `suggest` — the customer wants a recommendation / doesn't know what to get.
 * - `junk`    — no orderable intent (greeting, small talk, noise, unintelligible).
 *
 * Adding a new intent is three edits: a value here, a row in `INTENT_ROUTE`, and (only if
 * it needs its own behavior) a handler node it routes to.
 */
export const intentSchema = z.enum(['order', 'suggest', 'junk']);
export type Intent = z.infer<typeof intentSchema>;

/** Safe fallback: an utterance we cannot classify runs the full proposer pipeline, so a real
 * order is never dropped. Also the state channel default before `classify` writes it. */
export const DEFAULT_INTENT: Intent = 'order';

/**
 * Maps each intent to the graph node it routes to out of `classify`. Used BOTH as the
 * router's path map (intent → destination node) in `addConditionalEdges`, so routing and
 * the intent set can't drift. An intent that needs no special handling points at
 * `normalize` (the order pipeline); one with its own behavior points at its handler node.
 */
export const INTENT_ROUTE = {
  order: 'normalize',
  suggest: 'suggest',
  junk: 'finalize',
} as const satisfies Record<Intent, string>;
