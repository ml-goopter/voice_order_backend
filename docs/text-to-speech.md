## Text-to-Speech

### Why?
- TTS makes the interaction with the customer smoother — the agent's spoken replies
  (clarifying questions and recommendations) are heard, not just read.

### What it does
When the Order Understanding agent ends a turn by **speaking** instead of writing the
cart, it emits `order.reply` (see `docs/agent-tools.md` §3). The Realtime Gateway, which
already forwards that reply text to the client, now also **synthesizes it with Cartesia
and streams the audio back over the same WebSocket**.

### Flow
```
order.reply (bus, carries language)
  → RealtimeGateway subscription
      → conn.send(order.reply)                         # reply text (unchanged)
      → TtsService.speak(conn, ctx, reply, language)
          → segmentText(reply)                          # split into ≈sentence segments
          → conn.send(tts.audio_start)
          → for each segment (sequential):
              provider.synthesize(segment, signal, lang) # Cartesia Sonic REST → one complete mp3
              → conn.send(tts.audio_chunk)              # base64 of a standalone file, seq 0..N-1
          → conn.send(tts.audio_end)                    # or tts.error if a segment fails
```

The trigger is the existing `order.reply` **bus event** — no new internal event is
introduced. The `request_id` on the reply correlates the audio stream to the reply text.
The `language` is the language the agent declared it wrote the reply in, defaulting to `en` when it
declared none (see Multilingual below).

**Why per-segment.** Each `tts.audio_chunk` is a **complete, standalone** audio file (a
self-contained mp3), not a slice of one continuous stream — mid-stream slices of a single mp3
aren't independently decodable (Layer III bit reservoir), so the client couldn't play them as
they arrive. Synthesizing each ≈sentence segment as its own Cartesia request yields an
independent mp3 per segment; the client plays segment 1 while segment 2 is still synthesizing
(progressive playback, low time-to-first-audio). Splitting into sentences (not one call for the
whole reply) is what keeps time-to-first-audio low. Cartesia bills per character, so N
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

### Multilingual
The LLM is instructed to **reply in the customer's language**, so the `order.reply` text is already
in it; the only job for TTS is to speak it in that language.

**The language comes from the agent, and ONLY from the agent.** The agent ends a spoken turn with
strict JSON `{reply, language}` and declares the ISO-639-1 code of the language it actually wrote the
reply in (see `agent-tools.md` §3). That value rides the `order.reply` event →
`TtsService.speak(…, language)` → `provider.synthesize(…, language)`. `toCartesiaLanguage()` maps the
code to Cartesia's primary subtag (`en_US`/`zh-CN` → `en`/`zh`). When the agent declares no usable
language the reply falls back to **`TTS_LANGUAGE`** (in `order-understanding-service.ts`), so the
deployment's configured default still decides what an undeclared reply is spoken in.

**STT's detected language is not consulted at all** — not even as a fallback. It was the original
source but proved unreliable: AssemblyAI's default streaming model returns `en` for every turn, and
the multilingual/pro tier needs entitlement that isn't reliably in effect. The agent writes the
reply, so it is the only thing that knows the language. `ordering/graph/parse-spoken-reply.ts`
shape-checks the declared code and drops anything that isn't a language code (an agent that says
`"Chinese"` yields no language → `TTS_LANGUAGE`, rather than forwarding garbage to Cartesia).

> `TTS_LANGUAGE` is applied at the **reply** boundary rather than inside the provider: `order.reply`
> is the only `speak` caller, so defaulting in `order-understanding-service.ts` is what keeps the
> knob live — hardcoding `en` there would silently override an operator who set it to anything else.
> Because that boundary always resolves a language, `language` is **required** from `speak` down
> through `synthesize`, and providers carry no default of their own.

`sonic-3.5` is multilingual (42 languages) and a **multi-locale Cartesia voice** speaks each one via
the `language` param while preserving its timbre — so a single `TTS_VOICE_ID` covers all languages.
(A voice used in a locale it doesn't natively support sounds accented; if you serve such a locale
heavily, front a per-language voice map here.) Note: `segmentText()` splits on sentence punctuation
followed by whitespace, so CJK text (no space after `。`) synthesizes as one larger chunk rather than
sub-segmenting — correct, just a higher time-to-first-audio for those languages.

### Provider abstraction (mirrors STT, design §14)
- `tts/tts-types.ts` — `TtsProvider` (`synthesize(text, signal, language?) → Promise<Buffer>`): one
  complete audio file per call, cancellable via the `AbortSignal`.
- `tts/segment-text.ts` — `segmentText(reply)` splits a reply into ≈sentence segments
  (decimal/price-safe, with a length cap), one per `synthesize` call.
- `tts/cartesia-tts-provider.ts` — Cartesia Sonic via the `@cartesia/cartesia-js` `tts.generate`
  endpoint; the response body is drained to bytes and returned as one buffer. The Cartesia-specific
  call is an injected `SpeakFn` so tests skip the network. `toCartesiaLanguage()` normalizes the
  language code.
- `tts/tts-client.ts` — `createTtsProvider()` factory; `NoopTtsProvider` fallback for an
  unknown provider or a keyless boot (empty buffer → `audio_start` + `audio_end`, no chunks).
- `tts/tts-service.ts` — segments the reply and orchestrates the `tts.*` frames on a socket,
  synthesizing one segment at a time (forwarding the reply's language); owned by the gateway (the
  sole holder of sockets). Adding a provider = one new file + one `case`.

### Config
| Env | Default | Meaning |
|---|---|---|
| `TTS_PROVIDER` | `cartesia` | `cartesia` \| `noop` |
| `CARTESIA_API_KEY` | — | required for `cartesia` (else falls back to noop) |
| `TTS_MODEL` | `sonic-3.5` | Cartesia Sonic model (multilingual) |
| `TTS_VOICE_ID` | (placeholder) | Cartesia voice UUID — use a multi-locale voice |
| `TTS_LANGUAGE` | `en` | ISO-639-1 fallback when the agent declared no reply language |
| `TTS_ENCODING` | `mp3` | audio encoding streamed to the client (`mp3` \| `linear16`) |
| `TTS_SAMPLE_RATE` | `24000` | Hz of the emitted audio; also required by the mp3 container |
| `TTS_BIT_RATE` | `128000` | mp3 bit rate (bps) for the Cartesia mp3 container |
