import { describe, it, expect } from 'vitest';
import type { HistoryTurn } from '../../contracts/cart-view.js';
import { mergeHistory } from './state.js';

describe('mergeHistory (Plan A conversation context)', () => {
  const turn = (text: string): HistoryTurn => ({ customer_text: text });

  it('appends the new turn after prior turns, oldest → newest', () => {
    const prev = [turn('one coke'), turn('and fries')];
    const next = [turn('make it two')];
    expect(mergeHistory(prev, next, 6)).toEqual([
      turn('one coke'),
      turn('and fries'),
      turn('make it two'),
    ]);
  });

  it('caps at the newest `cap` turns, dropping the oldest', () => {
    const prev = [turn('t1'), turn('t2'), turn('t3')];
    const next = [turn('t4')];
    expect(mergeHistory(prev, next, 3).map((h) => h.customer_text)).toEqual(['t2', 't3', 't4']);
  });
});
