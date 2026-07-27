import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import { logger } from '../config/logger.js';
import { VoiceMessageHandler } from './voice-message-handler.js';
import { VoiceSessionManager } from './voice-session-manager.js';
import { EventBus } from '../events/event-bus.js';
import { TIMEOUTS } from '../config/constants.js';
import type { SttProvider } from '../stt/stt-provider.js';
import type { SttStream, SttStreamHandlers } from '../stt/stt-types.js';
import type { ClientConnection } from '../realtime/client-registry.js';
import type { OutboundMessage } from '../realtime/realtime-message-types.js';
import { RateLimitTimeoutError } from '../ratelimit/rate-limiter.js';

/** Captures the handlers passed to openStream so the test can drive STT events. */
class FakeSttProvider implements SttProvider {
  readonly name = 'fake';
  handlers!: SttStreamHandlers;
  stream: SttStream & { sendAudio: Mock<(chunk: Buffer) => void>; stop: Mock<() => Promise<void>>; close: Mock<() => void> } = {
    sendAudio: vi.fn<(chunk: Buffer) => void>(),
    stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    close: vi.fn<() => void>(),
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
    device_id: 'dev_1',
    send: (m) => sent.push(m),
    close: () => undefined,
    isAlive: () => true,
  };

  const events: Record<string, unknown[]> = {};
  const capture = (name: 'stt.final_transcript.received' | 'voice.session_ended' | 'voice.session_failed') =>
    bus.on(name, (p) => (events[name] = [...(events[name] ?? []), p]));
  capture('stt.final_transcript.received');
  capture('voice.session_ended');
  // Voice notifies the client of its own STT/timeout failures directly via a voice.error frame and
  // does NOT emit voice.session_failed (that event is ordering-only, forwarded by the gateway).
  // Captured here to pin that voice never emits it.
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
    stt.handlers.onFinal('two burgers');
    const final = events['stt.final_transcript.received']?.[0] as Record<string, unknown>;
    expect(final).toMatchObject({ session_id: 's1', cart_id: 'c1', pos_config_id: 7, text: 'two burgers' });
    expect(final).not.toHaveProperty('language'); // STT language detection is not plumbed anywhere.
    expect(typeof final['request_id']).toBe('string');
  });

  it('logs voice.final_transcript binding request_id to the session (session→turn join)', async () => {
    const { handler, conn, stt } = setup();
    const infoSpy = vi.spyOn(logger, 'info');
    await handler.handleStart(conn, startMsg);
    stt.handlers.onFinal('two burgers');
    expect(infoSpy).toHaveBeenCalledWith(
      'voice.final_transcript',
      expect.objectContaining({ session_id: 's1', cart_id: 'c1', request_id: expect.any(String) }),
    );
    infoSpy.mockRestore();
  });

  it('sends the final transcript to the client for display on a final', async () => {
    const { handler, conn, stt, sent } = setup();
    await handler.handleStart(conn, startMsg);
    stt.handlers.onFinal('two burgers');
    expect(sent).toContainEqual({ type: 'voice.final_transcript', session_id: 's1', text: 'two burgers' });
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
    stt.handlers.onFinal('one coke');
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
      expect(events['voice.session_failed']).toBeUndefined(); // voice notifies the client directly, not via the bus
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

      stt.handlers.onFinal('two burgers'); // stray late final
      expect(events['stt.final_transcript.received']).toBeUndefined(); // never reaches the cart
      expect(sent.some((m) => m.type === 'voice.final_transcript')).toBe(false); // nor the client display
      expect(events['voice.session_ended']).toBeUndefined();
      expect(sent).toContainEqual({ type: 'voice.error', session_id: 's1', reason: 'final_transcript_timeout', message: 'I did not catch that. Please try again.' });
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
      expect(sent.filter((m) => m.type === 'voice.error')).toHaveLength(1); // single failure notice, no orphaned timer
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
    expect(events['voice.session_failed']).toBeUndefined(); // voice notifies directly; it does not emit this event
  });

  it('degrades a rate-limited STT open to a stt_busy voice.error the customer can retry past', async () => {
    const { manager, stt, bus, conn, sent, events } = setup();
    stt.openStream = () => Promise.reject(new RateLimitTimeoutError('deadline', 'stt: timed out'));
    const handler = new VoiceMessageHandler(manager, stt, bus);

    await handler.handleStart(conn, startMsg);

    // Local saturation is transient and the customer's own retry is the fix, so it must not read
    // as the terminal "unavailable" failure.
    expect(sent).toContainEqual({
      type: 'voice.error',
      session_id: 's1',
      reason: 'stt_busy',
      message: "We're a bit busy right now — please try again in a moment.",
    });
    expect(manager.get('s1')).toBeUndefined(); // orphaned session torn down
    expect(events['voice.session_failed']).toBeUndefined(); // voice notifies directly; it does not emit this event
  });

  // A stream that finishes connecting AFTER its session left the registry has no other owner: the
  // session is unreachable, so nothing can ever call stop()/close() on it. The socket then bills
  // until AssemblyAI's 3-hour cutoff and — worse — its rate-limiter permit is retired for good.
  describe('a stream that resolves after its session is gone', () => {
    /** openStream with the first call held open, so a second voice.start / a disconnect can
     *  interleave inside the connect round-trip. */
    function pendingFirstOpen(stt: FakeSttProvider) {
      const orphan: SttStream & { close: Mock<() => void> } = {
        sendAudio: vi.fn<(chunk: Buffer) => void>(),
        stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
        close: vi.fn<() => void>(),
      };
      let calls = 0;
      let release!: () => void;
      stt.openStream = (h) => {
        stt.handlers = h;
        if (++calls === 1) return new Promise<SttStream>((r) => (release = () => r(orphan)));
        return Promise.resolve(stt.stream);
      };
      return { orphan, release: () => release() };
    }

    it('closes it when a concurrent voice.start superseded the session mid-connect', async () => {
      const { manager, stt, bus, conn } = setup();
      const { orphan, release } = pendingFirstOpen(stt);
      const handler = new VoiceMessageHandler(manager, stt, bus);

      const first = handler.handleStart(conn, startMsg); // suspends at `await openStream`
      await handler.handleStart(conn, startMsg); // hands-free restart, inside the round-trip
      release();
      await first;

      expect(orphan.close).toHaveBeenCalledTimes(1); // socket dropped, permit handed back
      // The live turn is untouched: the orphan must not reattach itself over it.
      expect(manager.get('s1')?.stream).toBe(stt.stream);
      expect(manager.get('s1')?.status).toBe('listening');
      expect(stt.stream.close).not.toHaveBeenCalled();
    });

    it('closes it when the client disconnected mid-connect', async () => {
      const { manager, stt, bus, conn } = setup();
      const { orphan, release } = pendingFirstOpen(stt);
      const handler = new VoiceMessageHandler(manager, stt, bus);

      const first = handler.handleStart(conn, startMsg);
      handler.handleDisconnect('s1');
      release();
      await first;

      expect(orphan.close).toHaveBeenCalledTimes(1);
      expect(manager.get('s1')).toBeUndefined(); // a late stream never resurrects the session
    });

    it('drops a final that arrives on a superseded session (it can never touch the cart)', async () => {
      const { manager, stt, bus, conn, events } = setup();
      const { release } = pendingFirstOpen(stt);
      const handler = new VoiceMessageHandler(manager, stt, bus);

      const first = handler.handleStart(conn, startMsg);
      const orphanHandlers = stt.handlers; // the retired session's callbacks
      await handler.handleStart(conn, startMsg);
      release();
      await first;

      orphanHandlers.onFinal('two burgers');
      expect(events['stt.final_transcript.received']).toBeUndefined();
    });

    it('a failed open does not tear down the session that already replaced it', async () => {
      const { manager, stt, bus, conn, sent } = setup();
      let calls = 0;
      let fail!: () => void;
      stt.openStream = (h) => {
        stt.handlers = h;
        if (++calls === 1) return new Promise<SttStream>((_r, reject) => (fail = () => reject(new Error('auth failed'))));
        return Promise.resolve(stt.stream);
      };
      const handler = new VoiceMessageHandler(manager, stt, bus);

      const first = handler.handleStart(conn, startMsg);
      await handler.handleStart(conn, startMsg);
      const live = manager.get('s1');
      fail();
      await first;

      // The failure belongs to the OLD session; removing by id would have closed the live turn.
      expect(manager.get('s1')).toBe(live);
      expect(stt.stream.close).not.toHaveBeenCalled();
      // ...and it must stay off the wire: the socket and session_id are shared with the live turn,
      // so a voice.error here would tell a customer who is mid-sentence that STT is unavailable.
      expect(sent).toEqual([]);
      expect(live?.status).toBe('listening');
    });

    it("a retired session's onError does not put a voice.error on the live turn", async () => {
      const { manager, stt, bus, conn, sent } = setup();
      const handler = new VoiceMessageHandler(manager, stt, bus);

      await handler.handleStart(conn, startMsg);
      const orphanHandlers = stt.handlers; // callbacks of the session about to be superseded
      await handler.handleStart(conn, startMsg); // hands-free mic restart
      const live = manager.get('s1')!;

      orphanHandlers.onError(new Error('socket closed'));

      expect(sent).toEqual([]);
      expect(live.status).toBe('listening'); // the live turn is untouched
    });

    it("a retired session's onPartial does not inject ghost text into the live display", async () => {
      const { manager, stt, bus, conn, sent } = setup();
      const handler = new VoiceMessageHandler(manager, stt, bus);

      await handler.handleStart(conn, startMsg);
      const orphanHandlers = stt.handlers;
      await handler.handleStart(conn, startMsg);
      stt.handlers.onPartial('two burgers'); // the LIVE turn's own partial

      orphanHandlers.onPartial('a large coffee'); // ghost from the retired session

      expect(sent).toEqual([{ type: 'voice.partial_transcript', session_id: 's1', text: 'two burgers' }]);
    });
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
        const { handler, conn, stt, events, sent } = setup();
        await handler.handleStart(conn, startMsg);
        stt.handlers.onPartial('two burgers'); // speech → arms the stopped-talking timer
        stt.handlers.onFinal('two burgers'); // a final is on record, session keeps listening

        vi.advanceTimersByTime(TIMEOUTS.partialIdleMs); // silence elapses → auto voice.stop
        await vi.runAllTimersAsync(); // let the async handleStop flush settle

        expect(stt.stream.stop).toHaveBeenCalledTimes(1); // flushed once, as if the client stopped
        expect(events['voice.session_ended']).toHaveLength(1); // final already present → clean end
        // A server-initiated stop tells the client the mic closed so it can drop its listening UI.
        expect(sent).toContainEqual({ type: 'voice.stopped', session_id: 's1', reason: 'idle' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('survives a throwing flush on the idle path (nothing awaits it, so it cannot reject)', async () => {
      vi.useFakeTimers();
      const unhandled: unknown[] = [];
      const trap = (reason: unknown): void => void unhandled.push(reason);
      process.on('unhandledRejection', trap);
      const warnSpy = vi.spyOn(logger, 'warn');
      try {
        const { handler, conn, stt } = setup();
        // The socket dies after a final is delivered: STT suppresses onError in that case, so the
        // session still looks 'listening' and none of stopSession's guards fire — the flush is
        // reached and forceEndpoint() throws.
        stt.stream.stop.mockRejectedValue(new Error('Socket is not open for communication'));
        await handler.handleStart(conn, startMsg);
        stt.handlers.onPartial('one coke'); // arms the idle timer

        await vi.advanceTimersByTimeAsync(TIMEOUTS.partialIdleMs);
        await vi.runAllTimersAsync();
        // Let any escaping rejection reach the process hook.
        vi.useRealTimers();
        await new Promise((r) => setImmediate(r));

        expect(unhandled).toEqual([]);
        expect(warnSpy).toHaveBeenCalledWith(
          'voice.idle_stop_failed',
          expect.objectContaining({ session_id: 's1', error: 'Socket is not open for communication' }),
        );
      } finally {
        warnSpy.mockRestore();
        process.off('unhandledRejection', trap);
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
        const { handler, conn, stt, sent } = setup();
        await handler.handleStart(conn, startMsg);
        stt.handlers.onPartial('one coke'); // arms the timer
        await handler.handleStop(conn, stopMsg); // manual stop clears it

        vi.advanceTimersByTime(TIMEOUTS.partialIdleMs * 2);
        await vi.runAllTimersAsync();
        expect(stt.stream.stop).toHaveBeenCalledTimes(1); // only the manual stop, timer never fired
        // A client-sent voice.stop is not echoed back as voice.stopped.
        expect(sent).not.toContainEqual(expect.objectContaining({ type: 'voice.stopped' }));
      } finally {
        vi.useRealTimers();
      }
    });

    it("a restarted session retires the prior session's idle timer (no ghost stop of the live turn)", async () => {
      vi.useFakeTimers();
      try {
        const { handler, conn, stt, manager, sent } = setup();

        // Turn 1: speech arms the idle timer, then the session is left as-is.
        await handler.handleStart(conn, startMsg);
        const first = manager.get('s1')!;
        const firstStream = stt.stream;
        stt.handlers.onPartial('two burgers'); // arms turn 1's idle timer

        // Turn 2 (hands-free restart) BEFORE turn 1's idle timer would fire.
        vi.advanceTimersByTime(TIMEOUTS.partialIdleMs - 1_000);
        await handler.handleStart(conn, startMsg);
        const second = manager.get('s1')!;
        expect(second).not.toBe(first); // a fresh session replaced it
        expect(firstStream.close).toHaveBeenCalledTimes(1); // turn 1's STT stream was closed

        // Let turn 1's original deadline pass: its ghost timer must NOT stop turn 2.
        vi.advanceTimersByTime(2_000);
        await vi.runAllTimersAsync();
        expect(sent).not.toContainEqual(expect.objectContaining({ type: 'voice.stopped' }));
        expect(second.stopping).toBe(false); // live turn untouched
        expect(manager.get('s1')?.status).toBe('listening');
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
