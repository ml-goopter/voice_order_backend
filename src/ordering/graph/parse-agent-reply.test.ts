import { describe, it, expect } from 'vitest';
import { parseAgentReply, parseSpokenReply } from './parse-agent-reply.js';

// The shared field rules, tested on the object directly — the shape `propose_cart` arguments take.
// `parseSpokenReply` below re-tests them through the text path; both callers must agree, which is
// the whole reason the rules live in one function.
describe('parseAgentReply', () => {
  it('keeps a usable reply and its declared language', () => {
    expect(parseAgentReply({ language: 'zh', reply: '好的' })).toEqual({ reply: '好的', language: 'zh' });
  });

  it('drops an off-format language without costing the reply', () => {
    expect(parseAgentReply({ reply: 'Added two lattes', language: 'Chinese' })).toEqual({
      reply: 'Added two lattes',
    });
    expect(parseAgentReply({ reply: 'Added two lattes' })).toEqual({ reply: 'Added two lattes' });
  });

  it('reports no reply for a blank or non-string one, and then declares no language either', () => {
    expect(parseAgentReply({ reply: '   ', language: 'en' })).toEqual({ reply: null });
    expect(parseAgentReply({ reply: 42, language: 'en' })).toEqual({ reply: null });
    expect(parseAgentReply({ language: 'en' })).toEqual({ reply: null });
    expect(parseAgentReply({})).toEqual({ reply: null });
  });
});

describe('parseSpokenReply', () => {
  it('parses the strict JSON the agent is prompted to emit (language first)', () => {
    expect(parseSpokenReply('{"language":"en","reply":"What size would you like?"}')).toEqual({
      reply: 'What size would you like?',
      language: 'en',
    });
  });

  // The prompt demands language-first so the model commits to a language before writing the reply
  // (agent-prompt-builder), but that ordering is a generation-time device, not a parse contract: a
  // model that slips back to reply-first must not lose its declared language over field order.
  it('parses either field order — the prompted order is not a parse requirement', () => {
    expect(parseSpokenReply('{"reply":"What size would you like?","language":"en"}')).toEqual({
      reply: 'What size would you like?',
      language: 'en',
    });
  });

  it('parses JSON carrying only a reply', () => {
    expect(parseSpokenReply('{"reply":"Anything else?"}')).toEqual({ reply: 'Anything else?' });
  });

  it('tolerates a ```json fence even though the prompt forbids it', () => {
    const raw = '```json\n{"reply":"您想要什么饮料?","language":"zh"}\n```';
    expect(parseSpokenReply(raw)).toEqual({ reply: '您想要什么饮料?', language: 'zh' });
  });

  it('normalizes the language code to lower case', () => {
    expect(parseSpokenReply('{"reply":"hi","language":"ZH-CN"}')).toEqual({
      reply: 'hi',
      language: 'zh-cn',
    });
  });

  it('degrades an off-format language without costing the reply', () => {
    expect(parseSpokenReply('{"reply":"hi","language":"Chinese"}')).toEqual({ reply: 'hi' });
    expect(parseSpokenReply('{"reply":"hi","language":"the customer spoke French"}')).toEqual({ reply: 'hi' });
  });

  it('speaks plain text as-is when the agent ignores the JSON format', () => {
    expect(parseSpokenReply('What size would you like?')).toEqual({ reply: 'What size would you like?' });
  });

  it('unwraps the object from surrounding prose rather than reading the braces aloud', () => {
    expect(parseSpokenReply('Sure! {"reply":"What size?","language":"en"}')).toEqual({
      reply: 'What size?',
      language: 'en',
    });
    expect(parseSpokenReply('{"reply":"Anything else?"} Let me know!')).toEqual({ reply: 'Anything else?' });
  });

  it('speaks plain text containing braces as-is (the span is not JSON)', () => {
    expect(parseSpokenReply('We have a {special} today')).toEqual({ reply: 'We have a {special} today' });
  });

  it('speaks the raw text when JSON parsing fails, rather than dropping the reply', () => {
    const truncated = '{"reply":"Sure, we have';
    expect(parseSpokenReply(truncated)).toEqual({ reply: truncated });
  });

  it('is a degenerate terminal when valid JSON carries no usable reply (never read a blob aloud)', () => {
    expect(parseSpokenReply('{"language":"en"}')).toEqual({ reply: null });
    expect(parseSpokenReply('{"reply":"   ","language":"en"}')).toEqual({ reply: null });
    expect(parseSpokenReply('{"reply":42}')).toEqual({ reply: null });
  });

  it('is a degenerate terminal for empty, blank, or absent text', () => {
    expect(parseSpokenReply(undefined)).toEqual({ reply: null });
    expect(parseSpokenReply('')).toEqual({ reply: null });
    expect(parseSpokenReply('   \n  ')).toEqual({ reply: null });
  });
});
