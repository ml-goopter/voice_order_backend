import { END } from '@langchain/langgraph';
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
 * Adding a new intent is three edits: a value here, a row in `INTENT_ROUTE`, and (only if
 * it needs its own behavior) a handler node it routes to.
 */
export const intentSchema = z.enum(['service', 'junk']);
export type Intent = z.infer<typeof intentSchema>;

/** Safe fallback: an utterance we cannot classify runs the full agent pipeline, so a real
 * order is never dropped. Also the state channel default before `classify` writes it. */
export const DEFAULT_INTENT: Intent = 'service';

/**
 * Maps each intent to the graph node (or `END`) it routes to out of `classify` (which runs after
 * `normalize`). Used as the router's path map in `addConditionalEdges`, so routing and the intent
 * set can't drift. `classify` is a JUNK-GATE: `service` routes into the agent pipeline
 * (`load_cart` → `agent`), where the agent decides the outcome. `junk` goes straight to `END` —
 * a non-orderable utterance (greeting, noise) is NOT recorded to history, so it can't pollute the
 * conversation context later fed to the agent.
 */
export const INTENT_ROUTE = {
  service: 'load_cart',
  junk: END,
} as const satisfies Record<Intent, string>;
