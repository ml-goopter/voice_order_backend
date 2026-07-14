import { describe, it, expect } from 'vitest';
import { CartesiaTtsProvider, toCartesiaLanguage, type SpeakFn } from './cartesia-tts-provider.js';

const provider = (speak: SpeakFn, defaultLanguage = 'en') =>
  new CartesiaTtsProvider('mp3', undefined, defaultLanguage, speak);

describe('toCartesiaLanguage', () => {
  it('maps an Odoo res.lang code to its ISO-639-1 primary subtag', () => {
    expect(toCartesiaLanguage('en_US')).toBe('en');
    expect(toCartesiaLanguage('fr_FR')).toBe('fr');
    expect(toCartesiaLanguage('zh_CN')).toBe('zh');
  });

  it('lowercases and accepts a hyphen separator', () => {
    expect(toCartesiaLanguage('PT-BR')).toBe('pt');
  });

  it('returns undefined for an absent or blank code', () => {
    expect(toCartesiaLanguage(undefined)).toBeUndefined();
    expect(toCartesiaLanguage('')).toBeUndefined();
  });
});

describe('CartesiaTtsProvider', () => {
  it('returns the synthesized bytes as a Buffer', async () => {
    const speak: SpeakFn = async () => new Uint8Array([1, 2, 3]);
    const buf = await provider(speak).synthesize('hi', new AbortController().signal);
    expect(buf).toEqual(Buffer.from([1, 2, 3]));
  });

  it('normalizes the language and passes it to the speak fn', async () => {
    let seen: string | undefined;
    const speak: SpeakFn = async (_text, language) => {
      seen = language;
      return new Uint8Array([1]);
    };
    await provider(speak).synthesize('hi', new AbortController().signal, 'fr_FR');
    expect(seen).toBe('fr');
  });

  it('falls back to the default language when the turn has none', async () => {
    let seen: string | undefined;
    const speak: SpeakFn = async (_text, language) => {
      seen = language;
      return new Uint8Array([1]);
    };
    await provider(speak, 'es').synthesize('hi', new AbortController().signal, undefined);
    expect(seen).toBe('es');
  });

  it('returns an empty buffer when the body is null', async () => {
    const speak: SpeakFn = async () => null;
    const buf = await provider(speak).synthesize('hi', new AbortController().signal);
    expect(buf).toEqual(Buffer.alloc(0));
  });

  it('rejects when the request fails', async () => {
    const speak: SpeakFn = async () => {
      throw new Error('cartesia_down');
    };
    await expect(provider(speak).synthesize('hi', new AbortController().signal)).rejects.toThrow('cartesia_down');
  });

  it('returns an empty buffer once the signal is aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const speak: SpeakFn = async () => new Uint8Array([1, 2]);
    const buf = await provider(speak).synthesize('hi', ctl.signal);
    expect(buf.length).toBe(0);
  });
});
