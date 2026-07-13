import type { LlmProvider } from '../../llm/llm-provider.js';
import { buildSuggestionPrompt } from '../../llm/suggestion-prompt-builder.js';
import type { SuggestionPromptInput } from '../../llm/suggestion-prompt-builder.js';
import { parseSuggestion } from '../schemas/suggestion.schema.js';
import type { Suggestion, SuggestedItem } from '../schemas/suggestion.schema.js';
import { logger } from '../../config/logger.js';
import { messageOf } from '../../shared/errors.js';

/** Spoken when the recommender fails — the turn still completes rather than dropping silently. */
const FALLBACK_REPLY = "I'm not sure what to suggest right now — what are you in the mood for?";

/**
 * Suggest-intent handler (design §6) — the customer asked for a recommendation. Calls the LLM
 * with the candidate items (real, available menu items) and the current cart, then validates its
 * output into a {@link Suggestion}. DEGRADES to a safe fallback reply (empty items) on any
 * failure — a transport error, non-JSON, or a schema miss must not fail the turn. Recommended
 * items are filtered to the candidates so the model can never surface an item that isn't on the
 * menu. Pure with respect to graph state (takes an input, returns a Suggestion) so it can be
 * unit-tested with a fake LlmProvider, mirroring the other nodes.
 */
export async function generateSuggestion(llm: LlmProvider, input: SuggestionPromptInput): Promise<Suggestion> {
  let raw: string;
  try {
    raw = await llm.complete(buildSuggestionPrompt(input));
  } catch (error) {
    logger.warn('order.suggest_failed', { reason: messageOf(error) });
    return { reply: FALLBACK_REPLY, items: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn('order.suggest_unparseable', { raw });
    return { reply: FALLBACK_REPLY, items: [] };
  }

  const result = parseSuggestion(parsed);
  if (!result.ok) {
    logger.warn('order.suggest_invalid', { raw, reason: result.error.message });
    return { reply: FALLBACK_REPLY, items: [] };
  }

  // Keep only recommended keys that are among this turn's candidates (so a hallucinated item can
  // never reach the customer), take the NAME from the candidate — the menu is the source of truth,
  // not the model's echo — and dedup so a repeated key is surfaced once.
  const byKey = new Map(input.candidate_items.map((c) => [c.menu_item_key, c.name]));
  const seen = new Set<string>();
  const items: SuggestedItem[] = [];
  for (const i of result.value.items) {
    const name = byKey.get(i.menu_item_key);
    if (name === undefined || seen.has(i.menu_item_key)) continue;
    seen.add(i.menu_item_key);
    items.push({ menu_item_key: i.menu_item_key, name });
  }
  return { reply: result.value.reply, items };
}
