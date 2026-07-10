# Plan — Silence / idle timeout to end a voice session

Status: **proposed, not implemented.**

## Problem

There is no server-side check for how long the customer has been silent. A session
leaves `listening` only on an explicit `voice.stop`, a socket disconnect, or an STT
error (see `voice/voice-message-handler.ts`). If the client never sends `voice.stop`
and the socket stays alive, the session sits in `listening` indefinitely.

The existing timers do **not** cover this:

| Timer (`config/constants.ts`) | Purpose | Why it's not a silence timer |
|---|---|---|
| `finalTranscriptMs` (4 s) | grace window for a final **after** `voice.stop` | only armed post-stop |
| `heartbeatIntervalMs/TimeoutMs` (15/30 s) | dead-socket ping/pong | transport liveness, not speech |
| `clarificationMs` (30 s) | expire a stalled clarification (ordering FIFO) | different module |
| `reconnectWindowMs` (60 s) | hold state open for reconnect | not speech |

## Key constraint — audio chunks are NOT a silence signal

The mic streams continuously while open, so `voice.audio_chunk` keeps flowing during
silence (quiet PCM/opus frames). Resetting an idle timer on each chunk would never
fire. The signal that distinguishes silence is **transcript activity**:

- `onPartial` fires as STT recognizes words — quiet the moment speech stops.
- `onFinal` fires when STT endpoints an utterance.

During real silence, audio chunks keep arriving but **no new partials/finals do**.
So the idle timer resets on transcript activity, not on audio.

## Two different silence thresholds (don't conflate)

- **Utterance endpointing (~0.4–0.8 s)** — STT provider silence window that closes an
  utterance and produces a *final*. Already handled by the provider (design §13).
- **Session-idle backstop (~20–30 s)** — "customer walked away." What this plan adds.
  Ends the *session*, not an utterance.

## Proposed behavior

```
on session start / onPartial / onFinal:
  reset idleTimer = setTimeout(onIdle, TIMEOUTS.idleMs)

handleAudioChunk:
  (do NOT touch the timer — silence still produces chunks)

onError / handleStop / handleDisconnect / any terminal transition:
  clearTimeout(idleTimer)

onIdle (fires only if still `listening`):
  flush the STT stream (a pending final may still land and take the normal path)
  if no final:
    session.status = 'ended'          # or 'failed' — see open question
    emit voice.session_ended          # + optional client notice
```

## Open questions to resolve before implementing

1. **Provider keepalive partials.** If AssemblyAI emits empty/keepalive partials during
   silence, "no partial for N seconds" breaks. Check `stt/assemblyai-stt-provider.ts`:
   reset only on partials whose `text` actually **grew**, not on every callback.
2. **End vs fail.** Idle-out is not an error — lean `voice.session_ended` (clean close),
   not `voice.session_failed`. Confirm the frontend treats `ended` gracefully.
3. **Value of `idleMs`.** Start ~20–30 s. New `TIMEOUTS.idleMs` in `config/constants.ts`.
4. **Client message.** Optional `voice.error`/notice like "Ended — tap to start again,"
   or end silently and let the UI reflect `idle`.
5. **Interaction with mid-flush finals.** Reuse the `finalReceived`/`finalTimer` guards
   already in `handleStop` so an idle-triggered flush and a late final don't double-fire.

## Touch points

- `config/constants.ts` — add `idleMs`.
- `voice/voice-session.ts` — add `idleTimer` field (mirrors `finalTimer`).
- `voice/voice-message-handler.ts` — arm/reset in `handleStart` + `onPartial`/`onFinal`;
  clear in `handleStop`/`handleDisconnect`/`onError`; add the `onIdle` handler.
- Tests: `voice/voice-message-handler.test.ts` — idle fires after silence; audio chunks
  alone do **not** keep it alive; a partial resets it; terminal states clear it.
- Docs: design.md §5 / §11 — note the idle backstop once implemented.
