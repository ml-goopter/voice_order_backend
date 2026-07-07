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
  only, never re-enters the backend flow); `onFinal` → mints a `request_id` and
  emits `stt.final_transcript.received`; `onError` → sends `voice.error` and emits
  `voice.session_failed`.
- `handleAudioChunk` forwards base64 audio to the stream (only while `listening`).
- `handleStop` flushes the stream and emits `voice.session_ended`. TODO: final-
  transcript timeout (`TIMEOUTS.finalTranscriptMs`, §11.2 C).
- `handleDisconnect` marks an in-flight session `interrupted` and drops partials
  (§5/§11.1) — cart is untouched; the client is asked to repeat on reconnect.
- **STT provider** is an interface (`SttProvider` → `SttStream`); `createSttProvider`
  selects by config. Only a `NoopSttProvider` exists today.

## Dependencies
- `stt` provider abstraction.
- `events` (EventBus) — emits final transcript + session lifecycle events.
- `realtime` (`ClientConnection`) — sends partials/errors; provides `pos_config_id`.

## Key files
- `voice/voice-session.ts` — per-session state (`idle|listening|interrupted|ended|failed`).
- `voice/voice-session-manager.ts` — session registry.
- `voice/voice-message-handler.ts` — start/audio/stop/disconnect handling.
- `stt/stt-provider.ts`, `stt/stt-types.ts` — provider + stream interfaces.
- `stt/stt-client.ts` — **stub** `NoopSttProvider`; TODO AssemblyAI/Deepgram (§14).
