---
type: Concept
title: TTS Module
description: Synthesizes order.reply text with Deepgram and streams tts.* audio frames to the client.
resource: src/tts
timestamp: 2026-07-14
---

# TTS Module

## Purpose
Gives the agent a voice. When Order Understanding ends a turn by **speaking** (a
clarifying question or a recommendation) it emits `order.reply`; the Realtime Gateway
already forwards that reply **text**, and the TTS module additionally **synthesizes it
with Deepgram and streams the audio** back over the same WebSocket. It owns no cart or
turn logic — it is a pure text→audio side-effect of `order.reply`.

## Mechanics
- **Trigger:** the existing `order.reply` **bus event** — no new internal event. The
  gateway's `order.reply` subscription sends the reply text, then calls
  `TtsService.speak(conn, { session_id, request_id }, reply)`. If the session has no
  socket, nothing is sent and TTS is skipped.
- **Segmentation:** `segmentText(reply)` splits the reply into ≈sentence segments (split on
  sentence punctuation followed by whitespace, so `$2.50` stays intact; a length cap
  hard-wraps an over-long clause). Each segment is synthesized into its own standalone file.
- **Frames (base64 in JSON, never binary):** per reply the service emits
  `tts.audio_start` (advertises `encoding`, plus `sample_rate` for raw PCM) →
  `tts.audio_chunk` × N (`seq` 0..N-1, base64 `audio`) → `tts.audio_end`, or `tts.error`
  on failure. Each `tts.audio_chunk` is one **complete, standalone** audio file (a
  self-contained mp3) for a segment — not a slice of a continuous stream — so the client
  plays each chunk on its own as it arrives (progressive playback). Matches the mic contract
  (audio is base64 inside JSON, §3).
- **Provider abstraction (mirrors STT):** `TtsProvider.synthesize(text, signal)` returns a
  `Promise<Buffer>` — one complete audio file per segment, cancellable via the `AbortSignal`.
  `DeepgramTtsProvider` drains the streamed response body and concatenates it into one buffer;
  the Deepgram-specific REST call is an injected `SpeakFn` (built in `tts-client.ts`) so tests
  skip the network. `createTtsProvider()` selects by `config.ttsProvider`; `NoopTtsProvider`
  is the fallback for an unknown provider or a keyless boot (returns an empty buffer —
  `audio_start` + `audio_end`, no chunks, so the reply text still stands).
- **Deepgram call:** `@deepgram/sdk` `speak.v1.audio.generate({ text, model, encoding })` per
  segment; the `BinaryResponse.stream()` body is adapted to an async generator, drained, and
  concatenated. Deepgram Aura bills per character, so one request per segment costs the same
  as one whole-reply request while cutting time-to-first-audio.
- **Encoding:** `mp3` by default (each segment's mp3 is self-describing and plays straight
  through a client media player). `TTS_ENCODING` can switch to `linear16`/`opus`/…; for
  raw-PCM encodings `TTS_SAMPLE_RATE` is advertised in `tts.audio_start` (standalone-per-chunk
  is an mp3 notion; raw-PCM chunks are concatenable segment bytes).
- **Barge-in (cancel-previous-only):** `TtsService` keeps an `AbortController` per
  `session_id`; a new reply aborts the previous one (stopping mid-segment and halting the
  segment loop) before starting, so audio never overlaps. The in-flight handle is dropped on
  completion (guarded so a barge-in/disconnect replacement isn't clobbered). Full barge-in on
  `voice.start` is out of scope.
- **Disconnect:** the gateway's `onDisconnect` calls `TtsService.cancel(session_id)`
  (alongside the STT teardown), aborting any in-flight synthesis so a dropped client no
  longer streams a paid Deepgram response into a closed socket.
- **Logging:** `TtsService` logs on a child logger bound to `{ session_id, request_id }`:
  `tts.synthesis_failed` (**warn**, with `error`) when synthesis fails — non-fatal, the
  reply text was already delivered — and, at **debug**, `tts.spoken` (`chunks`) on
  completion and `tts.superseded` on a barge-in cancel. Keyless/unknown-provider boots warn
  once via the factory (`tts.deepgram_no_key` / `tts.noop_provider_in_use`).

## Dependencies
- `events` (EventBus) — the `order.reply` trigger (consumed in the gateway).
- `realtime` (`ClientConnection`) — sends the `tts.*` frames; the gateway owns sockets and
  constructs `TtsService`.
- `config/env` — provider/key/model/encoding settings.
- `@deepgram/sdk` — Deepgram Aura REST speak client.

## Key files
- `tts/tts-types.ts` — `TtsProvider` interface (`synthesize(text, signal) → Promise<Buffer>`).
- `tts/segment-text.ts` — `segmentText(reply)`: split a reply into ≈sentence segments.
- `tts/deepgram-tts-provider.ts` — Deepgram Aura provider + injectable `SpeakFn`; drains the
  streamed body into one buffer per segment.
- `tts/tts-client.ts` — `createTtsProvider()` factory (`deepgram` → real, else noop) +
  the real `SpeakFn` (client construction, streamed body → async generator).
- `tts/tts-service.ts` — segments the reply, synthesizes one segment at a time, and
  orchestrates `tts.*` frames on a socket; per-session cancel.
- Wiring: `realtime/realtime-gateway.ts` (`order.reply` → `tts.speak`),
  `realtime/realtime-message-types.ts` (`tts.*` outbound messages), `app.ts` (composition).
