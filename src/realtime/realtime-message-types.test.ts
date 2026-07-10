import { describe, it, expect } from 'vitest';
import { parseInbound } from './realtime-message-types.js';

describe('parseInbound', () => {
  it('returns null for invalid JSON', () => {
    expect(parseInbound('not json')).toBeNull();
  });

  it('returns null for JSON that is not an object', () => {
    expect(parseInbound('42')).toBeNull();
    expect(parseInbound('true')).toBeNull();
    expect(parseInbound('"a string"')).toBeNull();
  });

  it('returns null for the JSON null literal', () => {
    expect(parseInbound('null')).toBeNull();
  });

  it('returns null for an object with no type field', () => {
    expect(parseInbound(JSON.stringify({ session_id: 's1' }))).toBeNull();
  });

  it('returns null for an unrecognized type', () => {
    expect(parseInbound(JSON.stringify({ type: 'voice.unknown' }))).toBeNull();
  });

  it.each([
    'voice.start',
    'voice.audio_chunk',
    'voice.stop',
    'order.clarification_answered',
    'connection.resume',
  ])('passes through a recognized %s message as-is', (type) => {
    const msg = { type, session_id: 's1' };
    expect(parseInbound(JSON.stringify(msg))).toEqual(msg);
  });

  it('trusts but does not validate sub-fields (deferred to handlers)', () => {
    // A voice.start missing cart_id still parses — field validation is the handler's job.
    const parsed = parseInbound(JSON.stringify({ type: 'voice.start' }));
    expect(parsed).toEqual({ type: 'voice.start' });
  });
});
