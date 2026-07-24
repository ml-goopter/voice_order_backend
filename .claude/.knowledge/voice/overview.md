---
type: Concept
title: Voice Module + STT
description: Voice session lifecycle and STT streaming; the only producer of stt.final_transcript.received.
resource: src/voice, src/stt
timestamp: 2026-07-07
---

# Voice Module + STT

## Purpose
Owns voice sessions and STT streaming (design §5). Relays **partial** transcripts
to the client for live display and emits the **final** transcript to the event bus.
It never calls the LLM or mutates the cart. The final transcript is the one signal
that may eventually touch the cart (§11 invariant).

## Mechanics
- `handleStart` creates a `VoiceSession` and opens an STT stream with handlers:
  `onPartial` → sends `voice.partial_transcript` straight to the client (display
  only, never re-enters the backend flow); `onFinal` → sends `voice.final_transcript`
  to the client (display twin of the partial — replaces it, display-only) and mints a
  `request_id` to emit `stt.final_transcript.received` (both skipped once the session is
  terminal, so a final arriving after a timeout/failure never reaches the client or cart).
  Neither carries a language: STT's per-turn detection is unreliable and is not plumbed
  anywhere — the agent declares the reply's language (docs/text-to-speech.md §Multilingual).
  Minting the `request_id` here is the one join point from a socket (`session_id`) to the
  turn (`request_id`) it spawns, so it also logs a `voice.final_transcript` line
  `{ request_id, session_id, cart_id }` — the anchor that ties the event-bus correlation
  trace back to a session. `onError` → sends
  `voice.error` and emits `voice.session_failed`. If `openStream` itself rejects
  (STT auth/handshake failure, §11.2 A), the orphaned session is removed and the
  same `voice.error`/`voice.session_failed` (reason `stt_failed`) is emitted.
- `handleAudioChunk` forwards base64 audio to the stream (only while `listening` and
  not yet `stopping` — `voice.stop` sets `stopping` so trailing chunks aren't fed
  into the flushing stream).
- **Stopped-talking detection** — `armIdleStop` (re)arms a per-session `stopTimer` on real
  speech progress (a growing partial or a final; empty/keepalive and verbatim-repeat
  partials are ignored via `lastPartialText`). It is never reset by `voice.audio_chunk`,
  since the mic keeps streaming audio during silence. If no progress arrives within
  `TIMEOUTS.partialIdleMs` (60 s) while `listening`, it first sends the client a `voice.stopped`
  (`reason: 'idle'`) notice — a server-initiated stop echoes back so the client can drop its
  listening UI; a client-sent `voice.stop` gets no such echo — then invokes `stopSession` on
  its own session, the same flush/grace path as a client `voice.stop`. Cleared on stop,
  disconnect, restart, and STT error; `unref`'d so it never holds the process open. **This
  is a per-session timeout, not per-turn:** its 60 s clock spans turns (any partial/final on
  the session resets it) and, when it fires, it ends the whole session — turn boundaries are
  the STT provider's ~1.6 s endpointing, which never sends `voice.stopped`. The separate
  ~20–30 s session-idle "walked away" backstop (`docs/voice-idle-timeout.md`) is still only proposed.
- **Session restart / ghost-timer safety** — a hands-free client sends a fresh `voice.start`
  every turn without a `voice.stop`. `handleStart` first retires any existing session for that
  `session_id` (`clearTimers` + `manager.remove`, which closes the old STT stream) before
  creating the new one, so the old session's idle timer cannot outlive it. As a backstop, the
  idle-timer callback bails if the session is no longer the registry's current one for that
  `session_id` (`manager.get(session_id) !== session`), and `stopSession` acts on the session
  it is handed rather than a fresh lookup — together these stop a stale timer from flushing
  whatever turn is current.
- `handleStop` ignores a repeat/concurrent `voice.stop` (guarded on `stopping`,
  which is set before the flush await, plus a pending timer / terminal status) so an
  overlapping stop never double-flushes the socket, then flushes the stream. If a
  final already arrived → `voice.session_ended`;
  otherwise it arms the final-transcript timeout (`TIMEOUTS.finalTranscriptMs`,
  §11.2 C): a late final cancels it and ends the session, else the session is marked
  `failed` with `voice.error`/`voice.session_failed` reason `final_transcript_timeout`.
- `handleDisconnect` clears any pending timeout, marks an in-flight session
  `interrupted`, and drops partials (§5/§11.1) — cart is untouched; the client is
  asked to repeat on reconnect.
- **STT provider** is an interface (`SttProvider` → `SttStream`); `createSttProvider`
  selects by `config.sttProvider`. `AssemblyAiSttProvider` (universal-streaming) is
  the real client; `NoopSttProvider` is the fallback for unknown providers or a
  keyless boot. Adding a provider = one new file + one `case`. Audio contract:
  PCM16 mono @ `STT_SAMPLE_RATE` (default 16000).
- **End-of-turn aggregation** — the turn boundary is the provider's job, not the
  backend's. `AssemblyAiSttProvider` fires one `onFinal` per endpointed turn; its
  silence thresholds are widened above AA defaults so a customer's natural mid-order
  pauses don't split one spoken order into several finals (each of which would be a
  separate `stt.final_transcript.received` → separate ordering turn + LLM round-trip).
  Tunables: `STT_MIN_TURN_SILENCE_MS` (`config.sttMinTurnSilenceMs`, default 1600 —
  silence to end a turn when confident, the primary lever) and `STT_MAX_TURN_SILENCE_MS`
  (`config.sttMaxTurnSilenceMs`, default 3600 — hard ceiling), passed as
  `minTurnSilence`/`maxTurnSilence` in `defaultTranscriberFactory`. The tradeoff is
  reply latency (~`minTurnSilence` after the customer truly finishes). Distinct from the
  partial-idle stop, which ends the *session*, not a turn. See
  `docs/customer-stop-detection.md`.

## Dependencies
- `stt` provider abstraction.
- `events` (EventBus) — emits final transcript + session lifecycle events.
- `realtime` (`ClientConnection`) — sends partials/errors; provides `pos_config_id`.

## Key files
- `voice/voice-session.ts` — per-session state (`idle|listening|interrupted|ended|failed`).
- `voice/voice-session-manager.ts` — session registry.
- `voice/voice-message-handler.ts` — start/audio/stop/disconnect handling.
- `stt/stt-provider.ts`, `stt/stt-types.ts` — provider + stream interfaces.
- `stt/stt-client.ts` — `createSttProvider` factory (`assemblyai` → real, else noop).
- `stt/assemblyai-stt-provider.ts` — real AssemblyAI streaming client (§14).
