import { describe, it, expect } from 'vitest';
import type { HistoryTurn } from '../schemas/order-graph-input.schema.js';
import { mergeHistory, trailingClarificationRun } from './state.js';

describe('mergeHistory (Plan A conversation context)', () => {
  const turn = (text: string, answer?: string): HistoryTurn =>
    answer === undefined ? { customer_text: text } : { customer_text: text, clarification_answer: answer };

  it('appends the new turn after prior turns, oldest → newest', () => {
    const prev = [turn('one coke'), turn('and fries')];
    const next = [turn('make it two', 'the large one')];
    expect(mergeHistory(prev, next, 6)).toEqual([
      turn('one coke'),
      turn('and fries'),
      turn('make it two', 'the large one'),
    ]);
  });

  it('caps at the newest `cap` turns, dropping the oldest', () => {
    const prev = [turn('t1'), turn('t2'), turn('t3')];
    const next = [turn('t4')];
    expect(mergeHistory(prev, next, 3).map((h) => h.customer_text)).toEqual(['t2', 't3', 't4']);
  });
});

describe('trailingClarificationRun', () => {
  const asked = (text: string, q: string): HistoryTurn => ({ customer_text: text, clarification_question: q });
  const plain = (text: string): HistoryTurn => ({ customer_text: text });

  it('is 0 when the last turn raised no question', () => {
    expect(trailingClarificationRun([asked('a', 'q1?'), plain('b')])).toBe(0);
  });

  it('counts consecutive trailing turns that raised an unanswered question', () => {
    expect(trailingClarificationRun([plain('a'), asked('b', 'q1?'), asked('c', 'q2?')])).toBe(2);
  });

  it('stops at the first resolved turn (one that raised no question)', () => {
    expect(trailingClarificationRun([asked('a', 'q1?'), plain('b'), asked('c', 'q2?')])).toBe(1);
  });

  it('is 0 for empty history', () => {
    expect(trailingClarificationRun([])).toBe(0);
  });
});
