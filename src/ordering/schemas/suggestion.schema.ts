/** Suggest-node output: a spoken recommendation + the real menu items it names (design §6). */
import { z } from 'zod';
import type { LangCode } from '../../shared/types.js';
import type { Result } from '../../shared/result.js';
import { err, ok } from '../../shared/result.js';
import { ValidationError } from '../../shared/errors.js';
import { formatZodError } from './zod-error.js';

const suggestionSchema = z.object({
  reply: z.string(),
  items: z.array(z.object({ menu_item_key: z.string(), name: z.string() })).default([]),
});

/** One recommended item — keys/names only, mirroring the prompt-facing candidate shape. */
export interface SuggestedItem {
  menu_item_key: string;
  name: string; // default display name (en_US-first); the single-string fallback
  /** All translatable names by res.lang code, when the candidate carries them; the client picks a locale. */
  names?: Record<LangCode, string>;
}

/** What the `suggest` node produces: a natural-language reply plus the items it recommends. */
export interface Suggestion {
  reply: string;
  items: SuggestedItem[];
}

/** Validate raw LLM output into a {@link Suggestion}; `formatZodError` gives a readable reason. */
export function parseSuggestion(u: unknown): Result<Suggestion> {
  const r = suggestionSchema.safeParse(u);
  if (!r.success) return err(new ValidationError(formatZodError(r.error)));
  return ok({ reply: r.data.reply, items: r.data.items });
}
