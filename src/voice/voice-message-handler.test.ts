import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../config/logger.js';
import { VoiceMessageHandler } from './voice-message-handler.js';
import { VoiceSessionManager } from './voice-session-manager.js';
import { EventBus } from '../events/event-bus.js';
import { TIMEOUTS } from '../config/constants.js';
import type { SttProvider } from '../stt/stt-provider.js';
import type { SttStream, SttStreamHandlers } from '../stt/stt-types.js';
import type { ClientConnection } from '../realtime/client-registry.js';
import type { OutboundMessage } from '../realtime/realtime-message-types.js';

/** Captures the handlers passed to openStream so the test can drive STT events. */
class FakeSttProvider implements SttProvider {
  readonly name = 'fake';
  handlers!: SttStreamHandlers;
  stream: SttStream & { sendAudio: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } = {
    sendAudio: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
  async openStream(handlers: SttStreamHandlers): Promise<SttStream> {
    this.handlers = handlers;
    return this.stream;
  }
}

function setup() {
  const manager = new VoiceSessionManager();
  const stt = new FakeSttProvider();
  const bus = new EventBus();
  const handler = new VoiceMessageHandler(manager, stt, bus);

  const sent: OutboundMessage[] = [];
  const conn: ClientConnection = {
    session_id: 's1',
    cart_id: 'c1',
    pos_config_id: 7,
    send: (m) => sent.push(m),
    close: () => undefined,
    isAlive: () => true,
  };

  const events: Record<string, unknown[]> = {};
  const capture = (name: 'stt.final_transcript.received' | 'voice.session_ended' | 'voice.session_failed') =>
    bus.on(name, (p) => (events[name] = [...(events[name] ?? []), p]));
  capture('stt.final_transcript.received');
  capture('voice.session_ended');
  capture('voice.session_failed');

  return { manager, stt, bus, handler, conn, sent, events };
}

const startMsg = { type: 'voice.start', session_id: 's1', cart_id: 'c1' } as const;
const stopMsg = { type: 'voice.stop', session_id: 's1' } as const;

describe('VoiceMessageHandler', () => {
  it('opens an STT stream and marks the session listening on start', async () => {
    const { handler, conn, manager } = setup();
    await handler.handleStart(conn, startMsg);
    expect(manager.get('s1')?.status).toBe('listening');
    expect(manager.get('s1')?.stream).not.toBeNull();
  });

  it('relays partial transcripts straight to the client', async () => {
    const { handler, conn, stt, sent } = setup();
    await handler.handleStart(conn, startMsg);
    stt.handlers.onPartial('two bur');
    expect(sent).toEqual([{ type: 'voice.partial_transcript', session_id: 's1', text: 'two bur' }]);
  });

  it('emits stt.final_transcript.received with a request_id on a final', async () => {
    const { handler, conn, stt, events } = setup();
    await handler.handleStart(conn, startMsg);
    stt.handlers.onFinal('two burgers', 'en');
    const final = events['stt.final_transcript.received']?.[0] as Record<string, unknown>;
    expect(final).toMatchObject({ session_id: 's1', cart_id: 'c1', pos_config_id: 7, text: 'two burgers', language: 'en' });
    expect(typeof final['request_id']).toBe('string');
  });

  it('logs voice.final_transcript binding request_id to the session (session→turn join)', async () => {
    const { handler, conn, stt } = setup();
    const infoSpy = vi.spyOn(logger, 'info');
    await handler.handleStart(conn, startMsg);
    stt.handlers.onFinal('two burgers', 'en');
    expect(infoSpy).toHaveBeenCalledWith(
      'voice.final_transcript',
      expect.objectContaining({ session_id: 's1', cart_id: 'c1', request_id: expect.any(String) }),
    );
    infoSpy.mockRestore();
  });

  it('sends the final transcript to the client for display on a final', async () => {
    const { handler, conn, stt, sent } = setup();
    await handler.handleStart(conn, startMsg);
    stt.handlers.onFinal('two burgers', 'en');
    expect(sent).toContainEqual({ type: 'voice.final_transcript', session_id: 's1', text: 'two burgers', language: 'en' });
  });

  it('forwards audio only while listening', async () => {
    const { handler, conn, stt, manager } = setup();
    await handler.handleStart(conn, startMsg);
    handler.handleAudioChunk(conn, { type: 'voice.audio_chunk', session_id: 's1', seq: 1, audio: Buffer.from([1, 2]).toString('base64') });
    expect(stt.stream.sendAudio).toHaveBeenCalledTimes(1);

    manager.get('s1')!.status = 'ended';
    handler.handleAudioChunk(conn, { type: 'voice.audio_chunk', session_id: 's1', seq: 2, audio: 'AAA=' });
    expect(stt.stream.sendAudio).toHaveBeenCalledTimes(1); // not forwarded
  });

  it('ends the session on stop when a final has already arrived', async () => {
    const { handler, conn, stt, events, manager } = setup();
    await handler.handleStart(conn, startMsg);
    stt.handlers.onFinal('one coke', 'en');
    await handler.handleStop(conn, stopMsg);
    expect(events['voice.session_ended']).toHaveLength(1);
    expect(events['voice.session_failed']).toBeUndefined();
    expect(manager.get('s1')?.status).toBe('ended');
  });

  it('fails the session if no final arrives within the timeout after stop (§11.2 C)', async () => {
    vi.useFakeTimers();
    try {
      const { handler, conn, sent, events, manager } = setup();
      await handler.handleStart(conn, startMsg);
      await handler.handleStop(conn, stopMsg);
      expect(events['voice.session_failed']).toBeUndefined(); // not yet

      vi.advanceTimersByTime(TIMEOUTS.finalTranscriptMs);
      expect(events['voice.session_failed']).toEqual([{ session_id: 's1', cart_id: 'c1', reason: 'final_transcript_timeout' }]);
      expect(sent).toContainEqual({ type: 'voice.error', session_id: 's1', reason: 'final_transcript_timeout', message: 'I did not catch that. Please try again.' });
      expect(manager.get('s1')?.status).toBe('failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops audio chunks that arrive after voice.stop (stream is flushing)', async () => {
    const { handler, conn, stt } = setup();
    await handler.handleStart(conn, startMsg);
    await handler.handleStop(conn, stopMsg);
    handler.handleAudioChunk(conn, { type: 'voice.audio_chunk', session_id: 's1', seq: 1, audio: 'AAA=' });
    expect(stt.stream.sendAudio).not.toHaveBeenCalled();
  });

  it('buffers audio streamed while the STT stream is still connecting and flushes it on connect', async () => {
    const { manager, stt, bus, conn } = setup();
    // Hold openStream pending to model the connect round-trip during which the
    // device already streams the onset of its utterance; resolve to the shared
    // stream mock so sendAudio is spied.
    let release!: () => void;
    stt.openStream = (h) => {
      stt.handlers = h;
      return new Promise<SttStream>((r) => (release = () => r(stt.stream)));
    };
    const handler = new VoiceMessageHandler(manager, stt, bus);

    const started = handler.handleStart(conn, startMsg); // suspends at `await openStream`
    for (let seq = 0; seq < 5; seq++) {
      handler.handleAudioChunk(conn, { type: 'voice.audio_chunk', session_id: 's1', seq, audio: Buffer.from([seq]).toString('base64') });
    }
    expect(stt.stream.sendAudio).not.toHaveBeenCalled(); // stream not open yet — retained, not sent

    release();
    await started;

    // The onset that arrived mid-connect must be flushed to STT in order — none dropped.
    expect(stt.stream.sendAudio).toHaveBeenCalledTimes(5);
    expect(stt.stream.sendAudio).toHaveBeenNthCalledWith(1, Buffer.from([0]));
    expect(stt.stream.sendAudio).toHaveBeenNthCalledWith(5, Buffer.from([4]));
    expect(manager.get('s1')?.status).toBe('listening');
  });

  it('ignores a final that lands after the §11.2 C timeout already failed the session', async () => {
    vi.useFakeTimers();
    try {
      const { handler, conn, stt, sent, events } = setup();
      await handler.handleStart(conn, startMsg);
      await handler.handleStop(conn, stopMsg);
      vi.advanceTimersByTime(TIMEOUTS.finalTranscriptMs); // session fails

      stt.handlers.onFinal('two burgers', 'en'); // stray late final
      expect(events['stt.final_transcript.received']).toBeUndefined(); // never reaches the cart
      expect(sent.some((m) => m.type === 'voice.final_transcript')).toBe(false); // nor the client display
      expect(events['voice.session_ended']).toBeUndefined();
      expect(events['voice.session_failed']).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a late final within the window cancels the timeout and ends the session', async () => {
    vi.useFakeTimers();
    try {
      const { handler, conn, stt, events } = setup();
      await handler.handleStart(conn, startMsg);
      await handler.handleStop(conn, stopMsg);

      stt.handlers.onFinal('two burgers'); // arrives before the deadline
      vi.advanceTimersByTime(TIMEOUTS.finalTranscriptMs);

      expect(events['stt.final_transcript.received']).toHaveLength(1);
      expect(events['voice.session_ended']).toHaveLength(1);
      expect(events['voice.session_failed']).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a second voice.stop as a no-op (no orphaned timer, single failure)', async () => {
    vi.useFakeTimers();
    try {
      const { handler, conn, stt, sent, events } = setup();
      await handler.handleStart(conn, startMsg);
      await handler.handleStop(conn, stopMsg);
      await handler.handleStop(conn, stopMsg); // repeat while the grace window is pending
      expect(stt.stream.stop).toHaveBeenCalledTimes(1); // not flushed twice

      vi.advanceTimersByTime(TIMEOUTS.finalTranscriptMs);
      expect(events['voice.session_failed']).toHaveLength(1);
      expect(sent.filter((m) => m.type === 'voice.error')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a voice.stop that arrives while the first stop is still flushing', async () => {
    const { handler, conn, stt } = setup();
    await handler.handleStart(conn, startMsg);

    // Make the first stop() hang so a second voice.stop can interleave during the flush.
    let release!: () => void;
    stt.stream.stop.mockReturnValueOnce(new Promise<void>((r) => (release = () => r())));

    const first = handler.handleStop(conn, stopMsg); // enters `await stream.stop()`
    await handler.handleStop(conn, stopMsg); // concurrent repeat, before finalTimer is armed
    release();
    await first;

    expect(stt.stream.stop).toHaveBeenCalledTimes(1); // not flushed twice
  });

  it('fails the session and notifies the client when opening the STT stream throws', async () => {
    const { manager, stt, bus, conn, sent, events } = setup();
    stt.openStream = () => Promise.reject(new Error('auth failed'));
    const handler = new VoiceMessageHandler(manager, stt, bus);

    await handler.handleStart(conn, startMsg);

    expect(manager.get('s1')).toBeUndefined(); // orphaned session torn down
    expect(sent).toContainEqual({ type: 'voice.error', session_id: 's1', reason: 'stt_failed', message: 'Speech recognition is unavailable. Please try again.' });
    expect(events['voice.session_failed']).toEqual([{ session_id: 's1', cart_id: 'c1', reason: 'stt_failed' }]);
  });

  it('marks an in-flight session interrupted and closes the stream on disconnect', async () => {
    const { handler, conn, stt, manager } = setup();
    await handler.handleStart(conn, startMsg);
    const session = manager.get('s1')!;
    handler.handleDisconnect('s1');
    expect(session.status).toBe('interrupted');
    expect(stt.stream.close).toHaveBeenCalledTimes(1); // via manager.remove
    expect(manager.get('s1')).toBeUndefined();
  });

  describe('stopped-talking detection (partial-idle auto-stop)', () => {
    it('auto-ends the turn when no new partial arrives after speech began', async () => {
      vi.useFakeTimers();
      try {
        const { handler, conn, stt, events } = setup();
        await handler.handleStart(conn, startMsg);
        stt.handlers.onPartial('two burgers'); // speech → arms the stopped-talking timer
        stt.handlers.onFinal('two burgers', 'en'); // a final is on record, session keeps listening

        vi.advanceTimersByTime(TIMEOUTS.partialIdleMs); // silence elapses → auto voice.stop
        await vi.runAllTimersAsync(); // let the async handleStop flush settle

        expect(stt.stream.stop).toHaveBeenCalledTimes(1); // flushed once, as if the client stopped
        expect(events['voice.session_ended']).toHaveLength(1); // final already present → clean end
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not reset the timer on audio chunks (silence still streams audio)', async () => {
      vi.useFakeTimers();
      try {
        const { handler, conn, stt } = setup();
        await handler.handleStart(conn, startMsg);
        stt.handlers.onPartial('one coke'); // arms the timer

        vi.advanceTimersByTime(1_000);
        handler.handleAudioChunk(conn, { type: 'voice.audio_chunk', session_id: 's1', seq: 1, audio: 'AAA=' });
        vi.advanceTimersByTime(TIMEOUTS.partialIdleMs - 1_000); // reaches the original deadline
        await vi.runAllTimersAsync();

        expect(stt.stream.stop).toHaveBeenCalledTimes(1); // audio did not push the deadline back
      } finally {
        vi.useRealTimers();
      }
    });

    it('a growing partial resets the timer; a repeat/keepalive partial does not', async () => {
      vi.useFakeTimers();
      try {
        const { handler, conn, stt } = setup();
        await handler.handleStart(conn, startMsg);

        stt.handlers.onPartial('one'); // arm at t0
        vi.advanceTimersByTime(TIMEOUTS.partialIdleMs - 500);
        stt.handlers.onPartial('one'); // identical → NOT a reset
        stt.handlers.onPartial(''); // empty/keepalive → NOT a reset
        vi.advanceTimersByTime(400);
        expect(stt.stream.stop).not.toHaveBeenCalled(); // still before the original deadline

        stt.handlers.onPartial('one two'); // grew → resets the countdown
        vi.advanceTimersByTime(TIMEOUTS.partialIdleMs - 100);
        expect(stt.stream.stop).not.toHaveBeenCalled(); // reset pushed the deadline out
        vi.advanceTimersByTime(100);
        await vi.runAllTimersAsync();
        expect(stt.stream.stop).toHaveBeenCalledTimes(1); // fires one partialIdleMs after the growth
      } finally {
        vi.useRealTimers();
      }
    });

    it('an explicit voice.stop disarms the timer (no double stop)', async () => {
      vi.useFakeTimers();
      try {
        const { handler, conn, stt } = setup();
        await handler.handleStart(conn, startMsg);
        stt.handlers.onPartial('one coke'); // arms the timer
        await handler.handleStop(conn, stopMsg); // manual stop clears it

        vi.advanceTimersByTime(TIMEOUTS.partialIdleMs * 2);
        await vi.runAllTimersAsync();
        expect(stt.stream.stop).toHaveBeenCalledTimes(1); // only the manual stop, timer never fired
      } finally {
        vi.useRealTimers();
      }
    });

    it('a disconnect disarms the timer', async () => {
      vi.useFakeTimers();
      try {
        const { handler, conn, stt } = setup();
        await handler.handleStart(conn, startMsg);
        stt.handlers.onPartial('one coke'); // arms the timer
        handler.handleDisconnect('s1'); // clears it and removes the session

        vi.advanceTimersByTime(TIMEOUTS.partialIdleMs * 2);
        await vi.runAllTimersAsync();
        expect(stt.stream.stop).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
