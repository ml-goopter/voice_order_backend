import { describe, it, expect } from 'vitest';
import { authenticate } from './session-auth.js';

const valid = {
  session_id: 's1',
  cart_id: 'c1',
  pos_config_id: 7,
  device_id: 'dev_1',
};

describe('authenticate', () => {
  it('resolves an AuthContext when every required field is present', () => {
    const r = authenticate(valid);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(valid);
  });

  it('ignores the token (auth is stubbed; the token is not verified)', () => {
    const r = authenticate({ ...valid, token: 'anything' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).not.toHaveProperty('token');
  });

  it('accepts pos_config_id 0 (guarded by === undefined, not truthiness)', () => {
    // POS #0 is a real config; a truthiness check would wrongly lock it out.
    const r = authenticate({ ...valid, pos_config_id: 0 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.pos_config_id).toBe(0);
  });

  it('includes table_id when present (dine-in)', () => {
    const r = authenticate({ ...valid, table_id: 42 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.table_id).toBe(42);
  });

  it('omits table_id when absent (takeout/untabled)', () => {
    const r = authenticate(valid);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).not.toHaveProperty('table_id');
  });

  it.each([
    ['session_id', { cart_id: 'c1', pos_config_id: 7, device_id: 'dev_1' }],
    ['cart_id', { session_id: 's1', pos_config_id: 7, device_id: 'dev_1' }],
    ['pos_config_id', { session_id: 's1', cart_id: 'c1', device_id: 'dev_1' }],
    ['device_id', { session_id: 's1', cart_id: 'c1', pos_config_id: 7 }],
  ])('rejects when %s is missing', (_field, params) => {
    const r = authenticate(params);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('unauthenticated');
      expect(r.error.name).toBe('AppError');
    }
  });

  it.each([
    ['session_id', { ...valid, session_id: '' }],
    ['cart_id', { ...valid, cart_id: '' }],
    ['device_id', { ...valid, device_id: '' }],
  ])('rejects when %s is an empty string (falsy)', (_field, params) => {
    const r = authenticate(params);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('unauthenticated');
  });
});
