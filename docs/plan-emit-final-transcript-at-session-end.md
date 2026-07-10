# Plan — Emit the final transcript only after the customer ends the voice session

**Status:** Proposed / not implemented. Captured for later; UX model still under
reconsideration (see §Open questions).

**Goal:** Run the ordering LLM pipeline **once per voice session**, on the transcript
of the whole session, instead of once per detected speech turn.

---

## 1. Current behavior (why it fires mid-stream)

- `stt.final_transcript.received` is emitted from a **single site**:
  `src/voice/voice-message-handler.ts:55`, inside the STT `onFinal` callback.
- AssemblyAI fires `onFinal` **once per "turn"** — a turn ends whenever the customer
  pauses long enough to trigger endpointing (`turn.end_of_turn`, deduped to the
  formatted event in `src/stt/assemblyai-stt-provider.ts:44-47`).
- So within one voice session (`voice.start` → `voice.stop`), each pause produces a
  final → a separate `stt.final_transcript.received` → a separate LLM turn through
  the per-cart FIFO (`CartTurnQueue`). The cart updates incrementally as the customer
  speaks.
- `voice.stop` (`handleStop`, `voice-message-handler.ts:131`) force-endpoints and
  flushes (`stop()` → `forceEndpoint()` + `close(true)`, `assemblyai-stt-provider.ts:72-76`),
  delivering the last in-progress segment as a final.

Net: the LLM runs per **utterance**, not per **session**.

## 2. Target behavior

- Partials remain display-only (unchanged).
- Each STT final is still shown live to the client (`voice.final_transcript`) but is
  **accumulated**, not acted upon.
- When the customer ends the session (`voice.stop`) and the stream flush completes,
  emit **one** coalesced `stt.final_transcript.received` covering the whole session,
  then `voice.session_ended`.
- The downstream ordering pipeline is **unchanged** — it simply receives one event per
  session instead of many.

## 3. Scope

All changes are contained in the **voice module**. No change to `src/ordering/*`,
`register-handlers.ts`, or the event contract (`stt.final_transcript.received` keeps
its shape).

### 3.1 `src/voice/voice-session.ts` — accumulation state

Add:

```ts
/** Final segments captured this session; joined and emitted once at voice.stop. */
finalSegments: string[] = [];
/** Language of the captured finals (last non-empty wins). */
finalLanguage?: LangCode;
```

(`finalReceived` stays — it now means "we captured at least one segment.")

### 3.2 `src/voice/voice-message-handler.ts` — `onFinal` (lines 41-71)

- **Keep** the live display send (`voice.final_transcript` to the client).
- **Keep** the terminal-status guard (line 45) and `session.finalReceived = true`.
- **Accumulate** instead of emit:
  ```ts
  if (language !== undefined) session.finalLanguage = language;
  session.finalSegments.push(text);
  ```
- **Delete** the bus emit `stt.final_transcript.received` (lines 55-62).
- **Delete** the "final arrived after voice.stop → clear timer → ended →
  voice.session_ended" block (lines 63-70). Session end now happens in `handleStop`.

### 3.3 `src/voice/voice-message-handler.ts` — `handleStop` (lines 131-167)

After `await session.stream.stop()` (which flushes the trailing final into
`finalSegments` before resolving — provider contract at
`assemblyai-stt-provider.ts:70-76`):

```ts
await session.stream.stop();
if (session.finalSegments.length > 0) {
  this.bus.emit('stt.final_transcript.received', {
    request_id: newRequestId(),
    session_id: session.session_id,
    cart_id: session.cart_id,
    pos_config_id: session.pos_config_id,
    text: session.finalSegments.join(' '),          // coalescing rule — see §Open questions
    ...(session.finalLanguage !== undefined ? { language: session.finalLanguage } : {}),
  });
  session.status = 'ended';
  this.bus.emit('voice.session_ended', { session_id: session.session_id, cart_id: session.cart_id });
  return;
}
// else: no speech captured — keep the §11.2 C grace window. Arm finalTimer for
// TIMEOUTS.finalTranscriptMs; if a late final lands in finalSegments, emit the
// coalesced transcript + voice.session_ended; otherwise fail
// (voice.session_failed, reason 'final_transcript_timeout').
```

The `finalTimer` / §11.2 C machinery stays but now gates "did we accumulate anything"
rather than "did one final arrive." In the normal case `finalSegments` is already
complete when `stop()` resolves, so the timer only matters for the no-speech case.

## 4. Edge cases to preserve

- **No speech at all** → still fails with `final_transcript_timeout` after the grace
  window (unchanged UX).
- **Late final after a terminal state** (timeout-failed / interrupted) → the terminal
  guard at line 45 still drops it; it must not revive the session.
- **Disconnect mid-session** (`handleDisconnect`) → discards `finalSegments` with the
  session; no emit. Unchanged.
- **Repeat/concurrent `voice.stop`** → the existing `stopping` / `finalTimer` guard
  (line 137) still prevents a double flush / double emit.
- **Language** across mixed-language segments → "last non-empty wins" (simple; revisit
  if multilingual sessions matter).

## 5. Ripple effects (behavioral, not code)

- **Per-cart FIFO** (`CartTurnQueue`) becomes ~one turn per session within a session,
  though it still serializes across concurrent sessions on the same cart. No code
  change needed.
- **Clarification loop** is driven by the ordering service and answered via the
  separate `order.clarification_answered` event, so it is unaffected by this change —
  but note a clarification now can only be triggered once per session (at end), not
  mid-speech.
- **Loss of incremental cart updates** — the cart no longer changes as the customer
  speaks; it changes once, after `voice.stop`. This is the main UX shift.

## 6. Open questions (must resolve before implementing)

1. **UX model — under reconsideration.** Removing per-utterance proposals means no
   live cart feedback while speaking. Decide whether that is the desired interaction
   before building this. (This is why the plan is parked.)
2. **Coalescing rule.** Default assumed here is **join all segments with spaces**
   (whole order in one transcript). Alternative: keep only the last segment (drops
   earlier speech — not recommended).
3. **Very long sessions.** Joining many segments yields a long transcript → larger LLM
   prompt. Probably fine, but worth a cap/telemetry if sessions can be long.

## 7. Verification (when built)

- Unit: `voice-message-handler.test.ts` — assert that N mid-session finals produce
  **zero** `stt.final_transcript.received` until `voice.stop`, then exactly **one**
  with the joined text; and that a no-speech stop still fails with
  `final_transcript_timeout`.
- E2E: a multi-utterance session yields a single proposal covering the whole order.
