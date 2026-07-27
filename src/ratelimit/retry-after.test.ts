import { describe, it, expect, afterEach } from 'vitest';
import { is429, retryAfterMs } from './retry-after.js';
import { RATE_LIMIT } from '../config/constants.js';

describe('retryAfterMs', () => {
  it('reads the delay-seconds form off an error', () => {
    expect(retryAfterMs({ status: 429, headers: { 'Retry-After': '3' } })).toBe(3_000);
  });

  it('reads a Headers object directly', () => {
    expect(retryAfterMs(new Headers({ 'retry-after': '2' }))).toBe(2_000);
  });

  it('reads the fetch Response headers form', () => {
    expect(retryAfterMs({ status: 429, headers: new Headers({ 'retry-after': '1.5' }) })).toBe(1_500);
  });

  it('turns the HTTP-date form into a delta from now', () => {
    const now = Date.parse('2026-07-27T12:00:00Z');
    const at = new Date(now + 4_000).toUTCString();
    expect(retryAfterMs({ headers: { 'retry-after': at } }, () => now)).toBe(4_000);
  });

  it('never returns a negative delay for a date already in the past', () => {
    const now = Date.parse('2026-07-27T12:00:00Z');
    const at = new Date(now - 30_000).toUTCString();
    expect(retryAfterMs({ headers: { 'retry-after': at } }, () => now)).toBe(0);
  });

  // The header is provider-controlled and a penalty only ever EXTENDS, so an unclamped value
  // takes the provider out for the rest of the process — one bad header, no way back.
  it('clamps an absurd delay-seconds value to the maximum penalty', () => {
    expect(retryAfterMs({ status: 429, headers: { 'retry-after': '86400' } })).toBe(RATE_LIMIT.maxPenaltyMs);
  });

  it('clamps a far-future HTTP-date to the maximum penalty', () => {
    const now = Date.parse('2026-07-27T12:00:00Z');
    const at = new Date(now + 86_400_000).toUTCString();
    expect(retryAfterMs({ headers: { 'retry-after': at } }, () => now)).toBe(RATE_LIMIT.maxPenaltyMs);
  });

  it('leaves a value inside the ceiling untouched', () => {
    expect(retryAfterMs({ headers: { 'retry-after': '30' } })).toBe(30_000);
  });

  it('falls back to the configured penalty when the header is absent or unusable', () => {
    expect(retryAfterMs({ status: 429 })).toBe(RATE_LIMIT.penalty429Ms);
    expect(retryAfterMs({ headers: {} })).toBe(RATE_LIMIT.penalty429Ms);
    expect(retryAfterMs({ headers: { 'retry-after': 'soon' } })).toBe(RATE_LIMIT.penalty429Ms);
    expect(retryAfterMs({ headers: { 'retry-after': '' } })).toBe(RATE_LIMIT.penalty429Ms);
    expect(retryAfterMs(undefined)).toBe(RATE_LIMIT.penalty429Ms);
  });

  // `Date.parse` is not a validity test. V8 reads '-5' as the year -5 and '12-25' as December
  // 2025, both real timestamps, so an UNPARSEABLE header used to clamp to a zero penalty — i.e.
  // `penalize(now + 0)`, a no-op — on the one signal proving our estimate was wrong. Zero must
  // stay reserved for a genuine HTTP-date that has already elapsed.
  it('falls back to the penalty for a value Date.parse would misread as a date', () => {
    // '2026' is deliberately absent: a bare integer IS the delay-seconds form, and is clamped.
    for (const raw of ['-5', '-0.5', '12-25', '2026-07-27', 'Jul 2026']) {
      expect(retryAfterMs({ status: 429, headers: { 'retry-after': raw } })).toBe(RATE_LIMIT.penalty429Ms);
    }
  });

  it('still accepts every RFC 7231 date form', () => {
    const now = Date.parse('2026-07-27T12:00:00Z');
    expect(retryAfterMs({ headers: { 'retry-after': 'Mon, 27 Jul 2026 12:00:04 GMT' } }, () => now)).toBe(4_000);
    expect(retryAfterMs({ headers: { 'retry-after': 'Monday, 27-Jul-26 12:00:04 GMT' } }, () => now)).toBe(4_000);
    // The REAL asctime form has no zone suffix — an earlier version of this case appended `GMT`,
    // which is not asctime at all and hid the local-time bug below.
    expect(retryAfterMs({ headers: { 'retry-after': 'Mon Jul 27 12:00:04 2026' } }, () => now)).toBe(4_000);
    // RFC 7231's own example: a single-digit day is space-padded to two columns.
    expect(
      retryAfterMs({ headers: { 'retry-after': 'Sun Nov  6 08:49:37 1994' } }, () => Date.parse('1994-11-06T08:49:33Z')),
    ).toBe(4_000);
  });

  // asctime is defined as GMT but carries no zone, and `Date.parse` reads a zone-less date as
  // LOCAL. Untreated, a 4-second Retry-After became 4s − offset on every host east of Greenwich —
  // clamped to a ZERO penalty, i.e. no back-off at all. Node re-reads `process.env.TZ` per call,
  // so the host offset can be varied here rather than assumed.
  describe('asctime is GMT regardless of the host timezone', () => {
    const originalTz = process.env.TZ;
    afterEach(() => {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    });

    for (const tz of ['Asia/Shanghai', 'America/Los_Angeles', 'UTC']) {
      it(`reads the same instant under TZ=${tz}`, () => {
        process.env.TZ = tz;
        const now = Date.parse('2026-07-27T12:00:00Z');
        expect(retryAfterMs({ headers: { 'retry-after': 'Mon Jul 27 12:00:04 2026' } }, () => now)).toBe(4_000);
      });
    }
  });
});

describe('is429', () => {
  it('is true for a 429 in either status spelling', () => {
    expect(is429({ status: 429 })).toBe(true);
    expect(is429({ statusCode: 429 })).toBe(true);
  });

  it('is false for anything else', () => {
    expect(is429({ status: 500 })).toBe(false);
    expect(is429(new Error('timeout'))).toBe(false);
    expect(is429(undefined)).toBe(false);
  });
});
