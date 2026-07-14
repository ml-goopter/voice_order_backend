## Text-to-Speech

### Why?
- TTS makes the interaction with the customer smoother — the agent's spoken replies
  (clarifying questions and recommendations) are heard, not just read.

### What it does
When the Order Understanding agent ends a turn by **speaking** instead of writing the
cart, it emits `order.reply` (see `docs/agent-tools.md` §3). The Realtime Gateway, which
already forwards that reply text to the client, now also **synthesizes it with Deepgram
and streams the audio back over the same WebSocket**.

### Flow
```
order.reply (bus)
  → RealtimeGateway subscription
      → conn.send(order.reply)                       # reply text (unchanged)
      → TtsService.speak(conn, ctx, reply)
          → segmentText(reply)                        # split into ≈sentence segments
          → conn.send(tts.audio_start)
          → for each segment (sequential):
              provider.synthesize(segment, signal)    # Deepgram Aura REST → one complete mp3
              → conn.send(tts.audio_chunk)            # base64 of a standalone file, seq 0..N-1
          → conn.send(tts.audio_end)                  # or tts.error if a segment fails
```

The trigger is the existing `order.reply` **bus event** — no new internal event is
introduced. The `request_id` on the reply correlates the audio stream to the reply text.

**Why per-segment.** Each `tts.audio_chunk` is a **complete, standalone** audio file (a
self-contained mp3), not a slice of one continuous stream — mid-stream slices of a single mp3
aren't independently decodable (Layer III bit reservoir), so the client couldn't play them as
they arrive. Synthesizing each ≈sentence segment as its own Deepgram request yields an
independent mp3 per segment; the client plays segment 1 while segment 2 is still synthesizing
(progressive playback, low time-to-first-audio). Splitting into sentences (not one call for the
whole reply) is what keeps time-to-first-audio low. Deepgram Aura bills per character, so N
segment requests cost the same as one whole-reply request.

### Client contract (frontend)
Per reply, the client receives `tts.audio_start` → `tts.audio_chunk` × N → `tts.audio_end`
(or `tts.error`), all carrying the reply's `request_id`. Each `tts.audio_chunk` holds one
**complete, standalone** audio file for a segment — the client plays each chunk on its own
(in `seq` order) rather than concatenating a stream. Audio is **base64 inside JSON** (no binary
frames — matches the mic contract). `tts.audio_start` advertises the `encoding` (and
`sample_rate` for raw PCM). Full details in
`../shared/docs/frontend-integration-guide.md` §4/§6/§7.

**Encoding: `mp3` by default.** Each segment's mp3 is self-describing and plays straight through
a client media player (e.g. an `<audio>`/MediaSource per chunk), which is far less client work
than raw PCM (base64 → Int16 → Float32 → Web Audio scheduling) and portable to mobile.
Configurable via `TTS_ENCODING` (e.g. `linear16`, `opus`); for raw-PCM encodings the sample rate
(`TTS_SAMPLE_RATE`) is advertised in `tts.audio_start` (and standalone-per-chunk is an mp3
notion — raw-PCM chunks are simply concatenable segment bytes).

### Barge-in (cancel-previous-only)
`TtsService` tracks the in-flight reply per `session_id` with an `AbortController`. A new reply
for the same session **aborts the previous one** (which stops mid-segment and halts the segment
loop) before starting, so audio never overlaps. A cancelled reply ends silently (no
`tts.audio_end`); the client treats a fresh `tts.audio_start` (new `request_id`) as superseding
the old audio. Stopping TTS the moment the customer starts speaking again (`voice.start`) is
**out of scope** for now.

### Provider abstraction (mirrors STT, design §14)
- `tts/tts-types.ts` — `TtsProvider` (`synthesize(text, signal) → Promise<Buffer>`): one complete
  audio file per call, cancellable via the `AbortSignal`.
- `tts/segment-text.ts` — `segmentText(reply)` splits a reply into ≈sentence segments
  (decimal/price-safe, with a length cap), one per `synthesize` call.
- `tts/deepgram-tts-provider.ts` — Deepgram Aura via the `@deepgram/sdk` REST speak endpoint
  (`speak.v1.audio.generate`); the response body is drained and concatenated into one buffer. The
  Deepgram-specific call is an injected `SpeakFn` so tests skip the network.
- `tts/tts-client.ts` — `createTtsProvider()` factory; `NoopTtsProvider` fallback for an
  unknown provider or a keyless boot (empty buffer → `audio_start` + `audio_end`, no chunks).
- `tts/tts-service.ts` — segments the reply and orchestrates the `tts.*` frames on a socket,
  synthesizing one segment at a time; owned by the gateway (the sole holder of sockets). Adding a
  provider = one new file + one `case`.

### Config
| Env | Default | Meaning |
|---|---|---|
| `TTS_PROVIDER` | `deepgram` | `deepgram` \| `noop` |
| `DEEPGRAM_API_KEY` | — | required for `deepgram` (else falls back to noop) |
| `TTS_MODEL` | `aura-2-thalia-en` | Deepgram Aura voice |
| `TTS_ENCODING` | `mp3` | audio encoding streamed to the client |
| `TTS_SAMPLE_RATE` | `24000` | Hz for raw-PCM encodings (linear16); ignored for mp3 |
