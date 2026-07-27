import { RATE_LIMIT } from '../config/constants.js';

/** Read one header off whatever shape the caller has in hand: a `Headers` (fetch), a plain
 *  record (SDK error meta), or anything else with a `get(name)`. Header names are
 *  case-insensitive, so a record is scanned case-folded. */
function headerValue(source: unknown, name: string): string | undefined {
  if (source === null || typeof source !== 'object') return undefined;
  const getter = (source as { get?: unknown }).get;
  if (typeof getter === 'function') {
    const v = (getter as (n: string) => unknown).call(source, name);
    return typeof v === 'string' ? v : undefined;
  }
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(source as Record<string, unknown>)) {
    if (k.toLowerCase() === wanted && typeof v === 'string') return v;
  }
  return undefined;
}

/** True for a provider 429. Covers the OpenAI SDK's `APIError.status` and the `statusCode`
 *  spelling used by other clients; anything else (500, timeout, network) is false. */
export function is429(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { status?: unknown; statusCode?: unknown };
  return e.status === 429 || e.statusCode === 429;
}

/**
 * How long to hold off after a 429, in milliseconds.
 *
 * `source` may be the error/response itself (its `headers` are read) or a `Headers` directly.
 * `Retry-After` is defined in both delay-seconds and HTTP-date form; a missing or unparseable
 * value falls back to `RATE_LIMIT.penalty429Ms`. `now` is wall-clock on purpose — the HTTP-date
 * form is wall-clock — and only the resulting DURATION is applied to a monotonic clock.
 *
 * The result is CLAMPED to `RATE_LIMIT.maxPenaltyMs`. The header is attacker- or bug-controlled
 * input and a penalty only ever extends, so an unclamped `Retry-After: 86400` would take the
 * provider out for the rest of the process.
 */
export function retryAfterMs(source: unknown, now: () => number = Date.now): number {
  const raw = headerValue(source, 'retry-after') ?? headerValue((source as { headers?: unknown })?.headers, 'retry-after');
  if (raw === undefined) return RATE_LIMIT.penalty429Ms;

  const trimmed = raw.trim();
  if (trimmed === '') return RATE_LIMIT.penalty429Ms;

  if (/^\d+(\.\d+)?$/.test(trimmed)) return clamp(Math.round(Number(trimmed) * 1000));

  // Gate the date form on it LOOKING like an HTTP-date first. `Date.parse` is far too permissive
  // to use as a validity test: V8 reads '-5' and '12-25' as years and returns a real timestamp
  // decades in the past, which then clamps to a ZERO penalty — no back-off at all on the one
  // signal proving our estimate was wrong. All three RFC 7231 date forms (IMF-fixdate, RFC 850,
  // asctime) begin with a weekday name, so that prefix is the cheap discriminator. Zero stays
  // reserved for a genuine date that has already elapsed.
  if (!HTTP_DATE_PREFIX.test(trimmed)) return RATE_LIMIT.penalty429Ms;
  // asctime carries no zone, and `Date.parse` reads a zone-less date as LOCAL time. RFC 7231
  // defines all three forms as GMT, so on a UTC+8 host a 4-second `Retry-After` would come back as
  // 4s − 8h, clamp to 0, and apply no back-off at all on the one signal proving our estimate was
  // wrong. Naming the zone is what makes the parse match the spec.
  const at = Date.parse(ASCTIME.test(trimmed) ? `${trimmed} GMT` : trimmed);
  if (Number.isNaN(at)) return RATE_LIMIT.penalty429Ms;
  return clamp(at - now());
}

const HTTP_DATE_PREFIX = /^(mon|tue|wed|thu|fri|sat|sun)/i;

/** RFC 7231 asctime, the one form with no zone suffix: `Sun Nov  6 08:49:37 1994` (the day is
 *  space-padded to two columns). The other two forms end in an explicit `GMT`. */
const ASCTIME = /^[a-z]{3} [a-z]{3} {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/i;

function clamp(ms: number): number {
  return Math.min(RATE_LIMIT.maxPenaltyMs, Math.max(0, ms));
}
