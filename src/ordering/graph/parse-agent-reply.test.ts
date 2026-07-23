import { describe, it, expect } from 'vitest';
import { parseAgentReply, parseSpokenReply } from './parse-agent-reply.js';

// The shared field rules, tested on the object directly — the shape `propose_cart` arguments take.
// `parseSpokenReply` below re-tests them through the text path; both callers must agree, which is
// the whole reason the rules live in one function.
describe('parseAgentReply', () => {
  it('keeps a usable reply and its declared language', () => {
    expect(parseAgentReply({ language: 'zh', reply: '好的' })).toEqual({
      reply: '好的',
      language: 'zh',
      mentioned_items: [],
    });
  });

  it('drops an off-format language without costing the reply', () => {
    expect(parseAgentReply({ reply: 'Added two lattes', language: 'Chinese' })).toEqual({
      reply: 'Added two lattes',
      mentioned_items: [],
    });
    expect(parseAgentReply({ reply: 'Added two lattes' })).toEqual({
      reply: 'Added two lattes',
      mentioned_items: [],
    });
  });

  it('reports no reply for a blank or non-string one, and then declares no language either', () => {
    expect(parseAgentReply({ reply: '   ', language: 'en' })).toEqual({ reply: null, mentioned_items: [] });
    expect(parseAgentReply({ reply: 42, language: 'en' })).toEqual({ reply: null, mentioned_items: [] });
    expect(parseAgentReply({ language: 'en' })).toEqual({ reply: null, mentioned_items: [] });
    expect(parseAgentReply({})).toEqual({ reply: null, mentioned_items: [] });
  });

  it('parses declared mentioned_items keys, preserving order', () => {
    expect(parseAgentReply({ reply: 'Try these.', mentioned_items: ['burger', 'coke'] })).toEqual({
      reply: 'Try these.',
      mentioned_items: ['burger', 'coke'],
    });
  });

  it('degrades a non-array mentioned_items to empty without touching reply', () => {
    expect(parseAgentReply({ reply: 'burger', mentioned_items: 'burger' })).toEqual({
      reply: 'burger',
      mentioned_items: [],
    });
  });

  it('drops non-string/blank entries from mentioned_items without touching reply', () => {
    expect(parseAgentReply({ reply: 'Try these.', mentioned_items: [1, '', null, 'coke'] })).toEqual({
      reply: 'Try these.',
      mentioned_items: ['coke'],
    });
  });

  it('forces mentioned_items to empty when reply is null, even if keys were declared', () => {
    expect(parseAgentReply({ mentioned_items: ['burger'] })).toEqual({ reply: null, mentioned_items: [] });
  });
});

describe('parseSpokenReply', () => {
  it('parses the strict JSON the agent is prompted to emit (language first)', () => {
    expect(parseSpokenReply('{"language":"en","reply":"What size would you like?"}')).toEqual({
      reply: 'What size would you like?',
      language: 'en',
      mentioned_items: [],
    });
  });

  // The prompt demands language-first so the model commits to a language before writing the reply
  // (agent-prompt-builder), but that ordering is a generation-time device, not a parse contract: a
  // model that slips back to reply-first must not lose its declared language over field order.
  it('parses either field order — the prompted order is not a parse requirement', () => {
    expect(parseSpokenReply('{"reply":"What size would you like?","language":"en"}')).toEqual({
      reply: 'What size would you like?',
      language: 'en',
      mentioned_items: [],
    });
  });

  it('parses JSON carrying only a reply', () => {
    expect(parseSpokenReply('{"reply":"Anything else?"}')).toEqual({
      reply: 'Anything else?',
      mentioned_items: [],
    });
  });

  it('parses mentioned_items declared alongside the reply', () => {
    expect(
      parseSpokenReply('{"language":"en","reply":"You might like these.","mentioned_items":["burger","coke"]}'),
    ).toEqual({
      reply: 'You might like these.',
      language: 'en',
      mentioned_items: ['burger', 'coke'],
    });
  });

  it('tolerates a ```json fence even though the prompt forbids it', () => {
    const raw = '```json\n{"reply":"您想要什么饮料?","language":"zh"}\n```';
    expect(parseSpokenReply(raw)).toEqual({ reply: '您想要什么饮料?', language: 'zh', mentioned_items: [] });
  });

  it('normalizes the language code to lower case', () => {
    expect(parseSpokenReply('{"reply":"hi","language":"ZH-CN"}')).toEqual({
      reply: 'hi',
      language: 'zh-cn',
      mentioned_items: [],
    });
  });

  it('degrades an off-format language without costing the reply', () => {
    expect(parseSpokenReply('{"reply":"hi","language":"Chinese"}')).toEqual({
      reply: 'hi',
      mentioned_items: [],
    });
    expect(parseSpokenReply('{"reply":"hi","language":"the customer spoke French"}')).toEqual({
      reply: 'hi',
      mentioned_items: [],
    });
  });

  it('speaks plain text as-is when the agent ignores the JSON format', () => {
    expect(parseSpokenReply('What size would you like?')).toEqual({
      reply: 'What size would you like?',
      mentioned_items: [],
    });
  });

  it('unwraps the object from surrounding prose rather than reading the braces aloud', () => {
    expect(parseSpokenReply('Sure! {"reply":"What size?","language":"en"}')).toEqual({
      reply: 'What size?',
      language: 'en',
      mentioned_items: [],
    });
    expect(parseSpokenReply('{"reply":"Anything else?"} Let me know!')).toEqual({
      reply: 'Anything else?',
      mentioned_items: [],
    });
  });

  it('speaks plain text containing braces as-is (the span is not JSON)', () => {
    expect(parseSpokenReply('We have a {special} today')).toEqual({
      reply: 'We have a {special} today',
      mentioned_items: [],
    });
  });

  it('speaks the raw text when JSON parsing fails, rather than dropping the reply', () => {
    const truncated = '{"reply":"Sure, we have';
    expect(parseSpokenReply(truncated)).toEqual({ reply: truncated, mentioned_items: [] });
  });

  it('is a degenerate terminal when valid JSON carries no usable reply (never read a blob aloud)', () => {
    expect(parseSpokenReply('{"language":"en"}')).toEqual({ reply: null, mentioned_items: [] });
    expect(parseSpokenReply('{"reply":"   ","language":"en"}')).toEqual({ reply: null, mentioned_items: [] });
    expect(parseSpokenReply('{"reply":42}')).toEqual({ reply: null, mentioned_items: [] });
    // A blob that declares mentioned_items but no usable reply is still degenerate — no items
    // without a reply to accompany.
    expect(parseSpokenReply('{"mentioned_items":["burger"]}')).toEqual({ reply: null, mentioned_items: [] });
  });

  it('is a degenerate terminal for empty, blank, or absent text', () => {
    expect(parseSpokenReply(undefined)).toEqual({ reply: null, mentioned_items: [] });
    expect(parseSpokenReply('')).toEqual({ reply: null, mentioned_items: [] });
    expect(parseSpokenReply('   \n  ')).toEqual({ reply: null, mentioned_items: [] });
  });
});
