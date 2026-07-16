import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Control isGraphBubbleUp so the test can drive both branches deterministically. instrument.ts
// imports ONLY this symbol from the package; the test verifies instrument's branch logic (log vs
// re-throw), not LangGraph's own bubble-up detection.
vi.mock('@langchain/langgraph', () => ({
  isGraphBubbleUp: (e: unknown) => (e as { __bubble?: boolean } | null)?.__bubble === true,
}));

import { node } from './instrument.js';
import { logger } from '../../config/logger.js';
import type { OrderStateType } from './state.js';

const state = { request_id: 'req_1', cart_id: 'cart_1', pos_config_id: 7 } as unknown as OrderStateType;

describe('node() instrumentation', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
  });
  afterEach(() => errSpy.mockRestore());

  it('passes a resolved value straight through, no logging', async () => {
    const wrapped = node('load_cart', async (s) => ({ ...s, marker: true }));
    await expect(wrapped(state)).resolves.toMatchObject({ marker: true });
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('logs order.node_failed once (node name + turn ids + error meta) then re-throws the same error', async () => {
    const boom = new Error('redis down');
    const wrapped = node('load_cart', () => {
      throw boom;
    });
    await expect(wrapped(state)).rejects.toBe(boom);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(
      'order.node_failed',
      expect.objectContaining({
        node: 'load_cart',
        request_id: 'req_1',
        cart_id: 'cart_1',
        pos_config_id: 7,
        message: 'redis down',
      }),
    );
  });

  it('re-throws a LangGraph bubble-up WITHOUT logging (interrupt/Command is control flow, not a fault)', async () => {
    const interrupt = Object.assign(new Error('__interrupt__'), { __bubble: true });
    const wrapped = node('agent', () => {
      throw interrupt;
    });
    await expect(wrapped(state)).rejects.toBe(interrupt);
    expect(errSpy).not.toHaveBeenCalled(); // regression guard: a logged bubble-up mislabels every clarification
  });
});
