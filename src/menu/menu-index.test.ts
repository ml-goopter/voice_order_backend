import { describe, it, expect } from 'vitest';
import type { Redis } from 'ioredis';
import { encodeVector, vecKey, keyIndexKey, ensureMenuIndex } from './menu-index.js';

/** Fake ioredis recording FT.* commands and a tiny string KV for the meta key. */
class FakeRedis {
  commands: string[] = [];
  private readonly kv = new Map<string, string>();
  constructor(private readonly hasIndex = false) {}

  async get(key: string): Promise<string | null> {
    return this.kv.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<'OK'> {
    this.kv.set(key, value);
    return 'OK';
  }
  async call(command: string, ...args: unknown[]): Promise<unknown> {
    this.commands.push(command);
    if (command === 'FT.CREATE' && this.hasIndex) throw new Error('Index already exists');
    if (command === 'FT.DROPINDEX' && !this.hasIndex) throw new Error('Unknown index name');
    return 'OK';
  }
}

describe('ensureMenuIndex', () => {
  it('is a no-op when dims <= 0 (stub embedder)', async () => {
    const redis = new FakeRedis();
    await ensureMenuIndex(redis as unknown as Redis, 0);
    expect(redis.commands).toEqual([]);
  });

  it('creates the index and records its signature when absent', async () => {
    const redis = new FakeRedis();
    await ensureMenuIndex(redis as unknown as Redis, 1024);
    expect(redis.commands).toContain('FT.CREATE');
    // Second ensure with the same signature is a no-op (no further FT commands).
    redis.commands.length = 0;
    await ensureMenuIndex(redis as unknown as Redis, 1024);
    expect(redis.commands).toEqual([]);
  });

  it('drops and recreates the index when the dimension changes', async () => {
    const redis = new FakeRedis();
    await ensureMenuIndex(redis as unknown as Redis, 1024);
    redis.commands.length = 0;
    await ensureMenuIndex(redis as unknown as Redis, 512);
    expect(redis.commands).toEqual(['FT.DROPINDEX', 'FT.CREATE']);
  });
});

describe('encodeVector', () => {
  it('packs a vector as little-endian FLOAT32 (4 bytes each)', () => {
    const buf = encodeVector([1, -1, 0.5, 0]);
    expect(buf.length).toBe(16);
    expect([0, 1, 2, 3].map((i) => buf.readFloatLE(i * 4))).toEqual([1, -1, 0.5, 0]);
  });

  it('produces an empty buffer for an empty vector', () => {
    expect(encodeVector([]).length).toBe(0);
  });
});

describe('key builders', () => {
  it('namespaces vector docs by pos/tmpl/index', () => {
    expect(vecKey(1, 42, 3)).toBe('menu:vec:1:42:3');
  });
  it('namespaces the menu_item_key lookup by pos', () => {
    expect(keyIndexKey(2, 'chicken_burger')).toBe('menu:key:2:chicken_burger');
  });
});
