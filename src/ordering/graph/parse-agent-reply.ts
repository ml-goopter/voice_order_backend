import type { LangCode } from '../../shared/types.js';

/** What the agent said this turn. IDENTICAL in both terminals: the standalone spoken reply and the
 *  fields bundled into `propose_cart`. `reply` is null when the agent said nothing usable. */
export interface AgentReply {
  reply: string | null;
  language?: LangCode;
}

/** ISO-639-1/2 primary subtag, optional region (`en`, `zh`, `yue`, `pt-BR`). */
const LANG_RE = /^[a-z]{2,3}([-_][a-z]{2,4})?$/i;

/**
 * Validate + normalize an agent-declared language code, degrading to `undefined` on anything
 * off-format (an empty/blank value, a name like "Chinese", a non-string) rather than forwarding
 * garbage downstream — the caller then falls back to `TTS_LANGUAGE`.
 */
function normalizeLangCode(raw: unknown): LangCode | undefined {
  const lang = typeof raw === 'string' ? raw.trim() : '';
  return LANG_RE.test(lang) ? (lang.toLowerCase() as LangCode) : undefined;
}

/**
 * Parse the reply fields off a plain object — `propose_cart` arguments, or the parsed spoken JSON
 * (see `parseSpokenReply`). The single place the per-field degrade rules live, so the two callers
 * can never drift apart on what counts as a usable reply: a JSON blob with no usable "reply" is a
 * degenerate terminal (never read aloud); an off-format "language" costs only the language, and
 * TTS falls back to TTS_LANGUAGE.
 */
export function parseAgentReply(obj: Record<string, unknown>): AgentReply {
  const reply = typeof obj.reply === 'string' && obj.reply.trim() ? obj.reply : null;
  if (reply === null) return { reply: null };
  // An off-format code ("Chinese") degrades to no language, not garbage forwarded to Cartesia.
  const language = normalizeLangCode(obj.language);
  return { reply, ...(language !== undefined ? { language } : {}) };
}

/**
 * The agent ends a spoken turn with strict JSON {"language": "...", "reply": "..."} (see
 * agent-prompt-builder, which demands that field order so the model commits to a language before
 * writing the reply). Field order is irrelevant HERE — this JSON.parses — so a model that emits the
 * old {reply, language} order still parses fine.
 *
 * Unwraps the assistant text (fence, prose around the outermost {…}) — text that isn't JSON is
 * spoken as-is, never dropped — then delegates the parsed object to `parseAgentReply`, which shares
 * the same field rules with the bundled `propose_cart.reply` path.
 */
export function parseSpokenReply(raw: string | undefined): AgentReply {
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
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(text.slice(open, close + 1));
    } catch {
      return { reply: text }; // Not JSON after all (e.g. truncated) — speak it rather than drop it.
    }
    // It parsed, so the raw text IS a JSON blob and is never speakable: `reply` or nothing.
    return parseAgentReply(obj);
  }
  return { reply: text };
}
