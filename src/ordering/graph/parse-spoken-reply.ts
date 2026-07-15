import type { LangCode } from '../../shared/types.js';

/** Parsed spoken-reply terminal. `reply` is null when the agent said nothing usable. */
export interface SpokenReply {
  reply: string | null;
  language?: LangCode;
}

/** ISO-639-1/2 primary subtag, optional region (`en`, `zh`, `yue`, `pt-BR`). */
const LANG_RE = /^[a-z]{2,3}([-_][a-z]{2,4})?$/i;

/**
 * The agent ends a spoken turn with strict JSON {"language": "...", "reply": "..."} (see
 * agent-prompt-builder, which demands that field order so the model commits to a language before
 * writing the reply). Field order is irrelevant HERE — this JSON.parses — so a model that emits the
 * old {reply, language} order still parses fine.
 *
 * Parse it, DEGRADING PER-FIELD: text that isn't JSON is spoken as-is (never drop a reply); a JSON
 * blob with no usable "reply" is a degenerate terminal (never read JSON aloud); an off-format
 * "language" costs only the language, and TTS falls back to TTS_LANGUAGE.
 */
export function parseSpokenReply(raw: string | undefined): SpokenReply {
  let text = raw?.trim();
  if (!text) return { reply: null };

  // Tolerate a ```json ... ``` fence even though the prompt forbids it.
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1]!.trim();

  // Parse the OUTERMOST {...} span rather than requiring the whole text to be the object: the model
  // sometimes wraps it in prose ("Sure! {...}") despite the prompt, and requiring a bare object
  // there would fall through and read the braces aloud to the customer. Prose outside the object is
  // not part of the contract, so it is dropped.
  const open = text.indexOf('{');
  const close = text.lastIndexOf('}');
  if (open !== -1 && close > open) {
    let obj: { reply?: unknown; language?: unknown };
    try {
      obj = JSON.parse(text.slice(open, close + 1));
    } catch {
      return { reply: text }; // Not JSON after all (e.g. truncated) — speak it rather than drop it.
    }
    // It parsed, so the raw text IS a JSON blob and is never speakable: `reply` or nothing.
    const reply = typeof obj.reply === 'string' && obj.reply.trim() ? obj.reply : null;
    if (reply === null) return { reply: null };
    const lang = typeof obj.language === 'string' ? obj.language.trim() : '';
    // An off-format code ("Chinese") degrades to no language, not garbage forwarded to Cartesia.
    return LANG_RE.test(lang) ? { reply, language: lang.toLowerCase() as LangCode } : { reply };
  }
  return { reply: text };
}
