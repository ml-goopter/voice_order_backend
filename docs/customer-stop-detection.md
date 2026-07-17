# Customer stop detection

How the backend decides a customer has finished talking so it can flush the STT
stream, take the final transcript, and end the turn.

There are **two independent triggers**. Either one ends the *turn* (flush → final →
`voice.session_ended`); they converge on the same `handleStop` path in
`voice/voice-message-handler.ts`.

| Trigger | Who fires it | Status |
|---|---|---|
| **1. User-initiated stop** — client sends `voice.stop` | the mobile app (button / release) | **implemented** |
| **2. Partial-transcript timeout** — no new partial for N ms | the backend, automatically | **implemented** |

---

## Trigger 1 — user-initiated stop (`voice.stop`)

The customer (or the app UI) signals end-of-turn explicitly. The app sends:

```jsonc
{ "type": "voice.stop", "session_id": "<sid>" }   // VoiceStopMsg
```

`handleStop` (`voice/voice-message-handler.ts`) then:

1. Ignores the message if a stop is already in flight, a grace timer is pending, or
   the session is already terminal (guards against a double `voice.stop`).
2. Sets `session.stopping = true` (so trailing `voice.audio_chunk`s are no longer fed
   into the stream being flushed) and disarms the stopped-talking timer (Trigger 2).
3. Awaits `session.stream.stop()` to flush STT.
4. **If a final already arrived** (`session.finalReceived`) → `status = 'ended'`,
   emit `voice.session_ended`.
5. **Otherwise** arm the final-transcript grace window (`TIMEOUTS.finalTranscriptMs`,
   4 s): a late final closes the session cleanly; if none lands the session is marked
   `failed` with `voice.error` / `voice.session_failed` reason
   `final_transcript_timeout` (design §11.2 C).

---

## End-of-turn aggregation (provider endpointing)

A turn's *boundary* is decided by the STT provider, not the backend. AssemblyAI
endpoints on silence and fires one `onFinal` per turn. With aggressive defaults
(~560 ms) a customer's natural mid-order pause ("two burgers… uh… and a coke")
endpoints early and splits **one spoken order into several finals — each its own
`stt.final_transcript.received`, i.e. a separate ordering turn and LLM round-trip**.

Rather than buffer/aggregate finals in the backend, we widen the provider's
endpointing silence so those pauses ride through as a single turn:

| Knob (`config/env.ts`) | Env var | Default | Meaning |
|---|---|---|---|
| `sttMinTurnSilenceMs` | `STT_MIN_TURN_SILENCE_MS` | 1600 | silence to end a turn when confident (primary lever) |
| `sttMaxTurnSilenceMs` | `STT_MAX_TURN_SILENCE_MS` | 3600 | hard ceiling: end the turn regardless of confidence |

Set in `stt/assemblyai-stt-provider.ts` (`minTurnSilence` / `maxTurnSilence`). The
tradeoff is latency: a customer who genuinely finishes waits ~`minTurnSilence`
before the agent replies. Too low re-splits orders; too high feels laggy.

This is orthogonal to the two turn-ending triggers below: endpointing decides where
*one turn* ends; the triggers decide when the *session* stops listening. The 60 s
partial-idle stop (Trigger 2) remains the walk-away backstop.

## Trigger 2 — partial-transcript timeout ("stopped talking")

**Goal:** end the turn automatically when the customer stops speaking, so they don't
have to press stop. If no new partial transcript arrives within an interval, treat the
customer as done and run the same stop/flush sequence as `voice.stop`.

### Why partials, not audio chunks

The mic streams continuously while open, so `voice.audio_chunk` keeps flowing during
silence (quiet PCM frames). Audio is therefore **not** a silence signal — a timer reset
on each chunk would never fire. The signal that tracks speech is transcript activity:

- `onPartial(text)` fires as STT recognizes words — it goes quiet the moment the
  customer stops talking.
- `onFinal(text)` fires when STT endpoints the utterance.

During real silence, audio keeps arriving but **no new partials do**. So the stop timer
resets on transcript activity, not on audio.

### How it works (implemented)

`VoiceSession` carries a `stopTimer` and the last partial text seen (`lastPartialText`).
`VoiceMessageHandler.armIdleStop(conn, session)` (re)arms the timer:

- **Reset on speech progress** — `onPartial` resets the timer only when `text` is
  non-empty **and** differs from `lastPartialText` (so empty/keepalive partials and
  verbatim repeats don't keep it alive); `onFinal` also resets it (a final is speech
  activity) and clears `lastPartialText` so the next utterance's first partial always
  counts as progress.
- **Never reset by audio** — `handleAudioChunk` does not touch the timer.
- **Fires only while `listening`** — the timer and its callback both bail if the session
  is `stopping` or terminal.
- **On fire** — after `TIMEOUTS.partialIdleMs` (60 s) of no progress, it calls
  `handleStop` with a synthetic `voice.stop`, reusing the exact same flush + 4 s grace
  window as a client-sent stop (guards, `finalReceived`, `finalTimer` all identical).
- **Cleared** on `handleStop`, `handleDisconnect`, and STT `onError`.
- **`unref`'d** so a pending timer never keeps the Node process alive on its own.

```
onPartial(text grew):   armIdleStop()            // reset the countdown
onFinal:                armIdleStop()            // final is activity; reset
handleAudioChunk:       (do NOT touch the timer) // silence still streams audio
handleStop / disconnect / onError:  clearTimeout(stopTimer)

stopTimer fires (still listening):  handleStop(synthetic voice.stop)
```

### Where this sits relative to the other timers

Don't conflate the three silence thresholds:

| Threshold | Scale | Ends | Owner |
|---|---|---|---|
| Utterance endpointing | ~0.4–0.8 s | one utterance (produces a *final*) | STT provider (design §13) |
| **Partial-idle stop (this doc)** | **60 s (`partialIdleMs`)** | **the turn** (auto-fires stop) | **backend, implemented** |
| Session-idle backstop | ~20–30 s | the whole session ("walked away") | backend ([`voice-idle-timeout.md`](voice-idle-timeout.md), proposed) |

The partial-idle stop is a turn-level convenience; the session-idle backstop is a
safety net for an abandoned socket. They can coexist — the partial-idle timer is shorter
and, when it fires, ends the current turn cleanly before the backstop would ever run.

### Tuning / notes

- **`partialIdleMs`** (`config/constants.ts`) is 60 s. Too short cuts off a
  customer mid-pause; too long feels laggy.
- **Keepalive partials.** The `text`-growth gate protects against a provider emitting
  empty/keepalive partials during silence. If AssemblyAI's partial semantics change,
  re-check the gate in `stt/assemblyai-stt-provider.ts`.
- **Provider endpointing.** If STT already endpoints and emits a final promptly, the
  final resets the timer; the auto-stop only fires when the customer then stays silent.

### Files

- `config/constants.ts` — `TIMEOUTS.partialIdleMs`.
- `voice/voice-session.ts` — `stopTimer`, `lastPartialText`.
- `voice/voice-message-handler.ts` — `armIdleStop`; reset in `onPartial`/`onFinal`;
  clears in `handleStop` / `handleDisconnect` / `onError`.
- `voice/voice-message-handler.test.ts` — auto-stop fires after partial silence; audio
  chunks don't keep it alive; a growing partial resets it while a repeat/keepalive does
  not; explicit stop and disconnect disarm it.
