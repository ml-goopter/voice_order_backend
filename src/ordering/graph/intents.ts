import { END } from '@langchain/langgraph';
import type { Intent } from '../../contracts/intent.js';

/**
 * Maps each intent to the graph node (or `END`) it routes to out of `classify` (which runs after
 * `normalize`). Used as the router's path map in `addConditionalEdges`, so routing and the intent
 * set can't drift. `classify` is a JUNK-GATE: `service` routes into the agent pipeline
 * (`load_cart` → `agent`), where the agent decides the outcome. `junk` goes straight to `END` —
 * a non-orderable utterance (greeting, noise) is NOT recorded to history, so it can't pollute the
 * conversation context later fed to the agent.
 *
 * The intent label set itself is the shared contract in `contracts/intent.ts`; only this
 * langgraph-specific routing table lives here.
 */
export const INTENT_ROUTE = {
  service: 'load_cart',
  junk: END,
} as const satisfies Record<Intent, string>;
