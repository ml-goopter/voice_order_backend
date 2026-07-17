/**
 * Token-usage observability types + pure helpers. Kept LangGraph-independent (like
 * ordering/graph/state.ts's `mergeHistory`) so the accumulation math is unit-testable without the
 * graph. Emitted as structured logs: `llm.usage` per call (in the provider) and `llm.turn_usage`
 * per agent turn (in OrderGraph). Raw token COUNTS only — cost is priced downstream from a per-model
 * table, so a price change never requires reprocessing history.
 */

/** Usage reported for ONE LLM call. `cachedTokens` is OPTIONAL on purpose: providers that don't
 *  report prompt-cache detail (e.g. Ollama) omit it, and "absent" must stay distinct from "0" so a
 *  real cache miss (0) isn't confused with "unknown" (absent) when averaging cache-hit rate. */
export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
}

/** Usage accumulated across the agent loop's calls in a single turn. `cacheReported` is the OR of
 *  every call's cache reporting: false means NO call reported cache detail, so the turn's cache-hit
 *  rate is unknown (omitted from the log) rather than a misleading 0. */
export interface TurnUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheReported: boolean;
  calls: number;
}

export const ZERO_TURN_USAGE: TurnUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cachedTokens: 0,
  cacheReported: false,
  calls: 0,
};

/** Fold one call's usage into the turn accumulator. Pure. A call that reports no `cachedTokens`
 *  contributes 0 cached but does NOT set `cacheReported` — so a turn stays "unknown" until some
 *  call actually reports cache detail. */
export function addUsage(prev: TurnUsage, next: LlmUsage): TurnUsage {
  return {
    promptTokens: prev.promptTokens + next.promptTokens,
    completionTokens: prev.completionTokens + next.completionTokens,
    totalTokens: prev.totalTokens + next.totalTokens,
    cachedTokens: prev.cachedTokens + (next.cachedTokens ?? 0),
    cacheReported: prev.cacheReported || next.cachedTokens !== undefined,
    calls: prev.calls + 1,
  };
}

/** Fraction of prompt tokens served from cache, rounded to 3dp. `null` when there are no prompt
 *  tokens to divide by (an undefined rate, not a 0% one). */
export function cacheHitRate(promptTokens: number, cachedTokens: number): number | null {
  if (promptTokens <= 0) return null;
  return Number((cachedTokens / promptTokens).toFixed(3));
}
