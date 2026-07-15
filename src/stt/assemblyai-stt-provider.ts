import { AssemblyAI, type StreamingTranscriber, type TurnEvent } from 'assemblyai';
import type { SttProvider } from './stt-provider.js';
import type { SttStream, SttStreamHandlers } from './stt-types.js';
import { config } from '../config/env.js';

/** Client audio contract: raw PCM16, mono, `config.sttSampleRate` Hz (design §5). */
const ENCODING = 'pcm_s16le' as const;

/** Builds a fresh streaming transcriber. Injectable so tests avoid the network. */
export type TranscriberFactory = () => StreamingTranscriber;

/**
 * AssemblyAI universal-streaming STT (design §14). Maps the provider's `turn`
 * events onto our three callbacks:
 *   - non-final turn        → onPartial (live display only)
 *   - end-of-turn (final)   → onFinal   (the one signal that may touch the cart, §11)
 *   - error / early close   → onError   (§11.2 B: never treat a partial as final)
 * Everything provider-specific stays in this file; swapping providers is a new
 * class + one `case` in stt-client.ts.
 */
export class AssemblyAiSttProvider implements SttProvider {
  readonly name = 'assemblyai';

  constructor(private readonly makeTranscriber: TranscriberFactory = defaultTranscriberFactory) {}

  async openStream(handlers: SttStreamHandlers): Promise<SttStream> {
    const transcriber = this.makeTranscriber();
    let finalDelivered = false;
    let lastFinalTurn = -1;
    // Set once we tear the socket down ourselves (stop/close) so the resulting
    // 'close' is not misread as a mid-speech drop.
    let selfClosing = false;

    transcriber.on('turn', (turn: TurnEvent) => {
      const text = turn.transcript.trim();
      if (!turn.end_of_turn) {
        if (text) handlers.onPartial(text);
        return;
      }
      // formatTurns=true yields two end-of-turn events per turn (unformatted then
      // formatted). Prefer the formatted one; dedupe by turn_order so a turn never
      // fires onFinal twice.
      if (!turn.turn_is_formatted || turn.turn_order === lastFinalTurn || !text) return;
      lastFinalTurn = turn.turn_order;
      finalDelivered = true;
      handlers.onFinal(text);
    });

    transcriber.on('error', (err: Error) => handlers.onError(err));

    // An UNEXPECTED close before any final is a mid-speech drop (§11.2 B): surface as
    // an error so the session fails and the customer is asked to repeat. A close we
    // initiated (stop/close) is expected — the handler's finalTranscript timeout
    // (§11.2 C) is the single authority for the no-final case, so stay silent.
    transcriber.on('close', (code: number, reason: string) => {
      if (!finalDelivered && !selfClosing) {
        handlers.onError(new Error(`stt_socket_closed_before_final_transcript: ${code} ${reason}`));
      }
    });

    // Rejects on auth/handshake failure (§11.2 A) so openStream surfaces the error.
    await transcriber.connect();

    return {
      // The SDK wants an ArrayBuffer; hand it the exact bytes this Buffer views.
      sendAudio: (chunk: Buffer) =>
        transcriber.sendAudio(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)),
      // Flush: force the current turn to end, then wait for session termination so a
      // pending final turn is delivered before we resolve. The handler-side
      // finalTranscript timeout (§11.2 C) is the hard backstop if none arrives.
      stop: async () => {
        selfClosing = true;
        transcriber.forceEndpoint();
        await transcriber.close(true);
      },
      // Cleanup on disconnect: drop the socket without waiting for a flush.
      close: () => {
        selfClosing = true;
        void transcriber.close(false);
      },
    };
  }
}

function defaultTranscriberFactory(): StreamingTranscriber {
  const client = new AssemblyAI({ apiKey: config.assemblyAiApiKey });
  return client.streaming.transcriber({
    sampleRate: config.sttSampleRate,
    encoding: ENCODING,
    formatTurns: true,
  });
}
