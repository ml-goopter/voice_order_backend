import { describe, it, expect, vi } from 'vitest';
import type { StreamingTranscriber, TurnEvent } from 'assemblyai';
import { AssemblyAiSttProvider, defaultTranscriberFactory } from './assemblyai-stt-provider.js';
import { config } from '../config/env.js';
import type { SttStreamHandlers } from './stt-types.js';

// Capture the params the real factory hands to AssemblyAI's transcriber, without a network client.
const transcriberParams = vi.fn();
vi.mock('assemblyai', () => ({
  AssemblyAI: class {
    streaming = {
      transcriber: (params: unknown) => {
        transcriberParams(params);
        return {} as StreamingTranscriber;
      },
    };
  },
}));

/** Minimal stand-in for the AssemblyAI StreamingTranscriber (no network). */
class FakeTranscriber {
  private readonly listeners: Record<string, (...args: unknown[]) => void> = {};
  sent: ArrayBufferLike[] = [];
  forced = 0;
  closedWith: boolean[] = [];
  connectCalls = 0;

  on(event: string, cb: (...args: unknown[]) => void): void {
    this.listeners[event] = cb;
  }
  async connect(): Promise<unknown> {
    this.connectCalls++;
    return { type: 'Begin' };
  }
  sendAudio(a: ArrayBufferLike): void {
    this.sent.push(a);
  }
  forceEndpoint(): void {
    this.forced++;
  }
  async close(wait?: boolean): Promise<void> {
    this.closedWith.push(Boolean(wait));
  }
  fire(event: string, ...args: unknown[]): void {
    this.listeners[event]?.(...args);
  }
}

function turn(partial: Partial<TurnEvent>): TurnEvent {
  return {
    type: 'Turn',
    turn_order: 0,
    turn_is_formatted: false,
    end_of_turn: false,
    transcript: '',
    end_of_turn_confidence: 1,
    words: [],
    ...partial,
  };
}

function collectHandlers() {
  return {
    partials: [] as string[],
    finals: [] as Array<{ text: string }>,
    errors: [] as string[],
    handlers(): SttStreamHandlers {
      return {
        onPartial: (t) => this.partials.push(t),
        onFinal: (t) => this.finals.push({ text: t }),
        onError: (e) => this.errors.push(e.message),
      };
    },
  };
}

async function open() {
  const fake = new FakeTranscriber();
  const provider = new AssemblyAiSttProvider(() => fake as unknown as StreamingTranscriber);
  const sink = collectHandlers();
  const stream = await provider.openStream(sink.handlers());
  return { fake, stream, sink };
}

describe('AssemblyAiSttProvider', () => {
  it('connects the stream when opened', async () => {
    const { fake } = await open();
    expect(fake.connectCalls).toBe(1);
  });

  it('maps non-final turns to onPartial (ignoring empty transcripts)', async () => {
    const { fake, sink } = await open();
    fake.fire('turn', turn({ transcript: 'chicken', end_of_turn: false }));
    fake.fire('turn', turn({ transcript: '   ', end_of_turn: false }));
    expect(sink.partials).toEqual(['chicken']);
    expect(sink.finals).toHaveLength(0);
  });

  it('emits onFinal once, on the formatted end-of-turn', async () => {
    const { fake, sink } = await open();
    // Unformatted end-of-turn comes first and must NOT fire a final.
    fake.fire('turn', turn({ transcript: 'two burgers', end_of_turn: true, turn_is_formatted: false, turn_order: 1 }));
    expect(sink.finals).toHaveLength(0);
    // Formatted end-of-turn fires the final. `language_code` is deliberately ignored — the turn's
    // detected language is not reported to anyone (docs/text-to-speech.md §Multilingual).
    fake.fire('turn', turn({ transcript: 'Two burgers.', end_of_turn: true, turn_is_formatted: true, turn_order: 1, language_code: 'en' }));
    // A duplicate formatted event for the same turn must not double-fire.
    fake.fire('turn', turn({ transcript: 'Two burgers.', end_of_turn: true, turn_is_formatted: true, turn_order: 1 }));
    expect(sink.finals).toEqual([{ text: 'Two burgers.' }]);
  });

  it('surfaces provider errors via onError', async () => {
    const { fake, sink } = await open();
    fake.fire('error', new Error('boom'));
    expect(sink.errors).toEqual(['boom']);
  });

  it('treats a close before any final as an error (never a partial-as-final)', async () => {
    const { fake, sink } = await open();
    fake.fire('close', 1006, 'abnormal');
    expect(sink.errors[0]).toContain('stt_socket_closed_before_final_transcript');
    expect(sink.finals).toHaveLength(0);
  });

  it('does not error on a close that follows a final', async () => {
    const { fake, sink } = await open();
    fake.fire('turn', turn({ transcript: 'Done.', end_of_turn: true, turn_is_formatted: true, turn_order: 1 }));
    fake.fire('close', 1000, 'ok');
    expect(sink.errors).toHaveLength(0);
  });

  it('does not error when the socket closes as part of a graceful stop (no final)', async () => {
    const { fake, stream, sink } = await open();
    await stream.stop(); // we initiate the teardown; the handler timeout owns the no-final case
    fake.fire('close', 1000, 'ok');
    expect(sink.errors).toHaveLength(0);
  });

  it('forwards audio bytes to the transcriber', async () => {
    const { fake, stream } = await open();
    stream.sendAudio(Buffer.from([1, 2, 3]));
    expect(fake.sent).toHaveLength(1);
    expect([...new Uint8Array(fake.sent[0]!)]).toEqual([1, 2, 3]);
  });

  it('stop() forces the endpoint and closes with flush; close() closes without flush', async () => {
    const { fake, stream } = await open();
    await stream.stop();
    expect(fake.forced).toBe(1);
    expect(fake.closedWith).toEqual([true]);
    stream.close();
    expect(fake.closedWith).toEqual([true, false]);
  });

  it('forwards the configured end-of-turn silence tuning to the transcriber', () => {
    defaultTranscriberFactory();
    expect(transcriberParams).toHaveBeenCalledWith(
      expect.objectContaining({
        minTurnSilence: config.sttMinTurnSilenceMs,
        maxTurnSilence: config.sttMaxTurnSilenceMs,
        formatTurns: true,
      }),
    );
  });
});
