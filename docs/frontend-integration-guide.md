# Realtime Gateway — Frontend Integration

How the mobile/web client talks to the backend. **One WebSocket per app carries
both voice and cart traffic.** The client streams microphone audio up, and receives
live partial transcripts, the settled final transcript, cart state, and spoken
recommendations down. All messages are JSON text frames (there are **no** binary
frames — audio is base64 inside JSON).

---

## 1. Connection

### Endpoint

| | |
|---|---|
| **WebSocket path** | `/ws` |
| **Host / port** | Same server as health; port **3000** by default |
| **Example** | `ws://<host>:3000/ws?session_id=…&cart_id=…&pos_config_id=…` |
| **Health check** | `GET /health` or `GET /healthz` (plain HTTP, same port) |

### Auth (query string on the upgrade URL)

Auth params ride on the connection URL's query string:

| Param | Type | Required | Notes |
|---|---|---|---|
| `session_id` | string | ✅ | Voice session id, e.g. `voice_session_123` |
| `cart_id` | string | ✅ | Globally unique cart key, e.g. `cart_456` |
| `pos_config_id` | integer | ✅ | The POS / "restaurant" id |
| `token` | string | ⚠️ | Accepted but **not yet verified** — you don't need to sign it yet |

If `session_id`, `cart_id`, or `pos_config_id` is missing (or `pos_config_id`
isn't an integer), the server closes the socket immediately with **close code
`4001`** (reason `"unauthenticated"`).

### Heartbeat / liveness

- The server sends a WS `ping` every **15 s**.
- A socket that misses a ping is **terminated** (dead-socket threshold **30 s**).

Just let your WS library answer pings automatically (browsers and `ws` do this
natively). There is no application-level heartbeat message.

---

## 2. Message envelope

Every message is a JSON object with a `type` discriminator, namespaced
`voice.*`, `order.*`, `cart.*`, `connection.*`.

An unknown or non-JSON message you send yields a `voice.error` with
`reason: "bad_message"` — it does **not** close the socket.

Id types: `session_id`, `cart_id`, `request_id` are opaque **strings**;
`pos_config_id` and all product ids are **integers**.

---

## 3. Inbound messages (client → gateway)

### `voice.start` — begin an utterance
Opens the transcription stream. Must be sent before any audio chunk.
```ts
{ type: 'voice.start', session_id: string, cart_id: string }
```

### `voice.audio_chunk` — stream mic audio
```ts
{
  type: 'voice.audio_chunk',
  session_id: string,
  seq: number,        // monotonically increasing chunk index
  audio: string       // base64-encoded PCM16 frame
}
```
**Audio format:**
- **PCM16** (16-bit signed, mono, little-endian), base64 in the `audio` field.
- Sample rate: **16 000 Hz** — match this on the client.
- Chunks sent before `voice.start` (or after `voice.stop`) are silently dropped.

### `voice.stop` — end of speech
```ts
{ type: 'voice.stop', session_id: string }
```
Ends the utterance and starts a **4 s** window for the final transcript. If none
arrives, you receive a `voice.error` with `reason: "final_transcript_timeout"`.
Repeat/concurrent `voice.stop` messages are ignored.

### `order.clarification_answered` — reply to a clarification question
```ts
{
  type: 'order.clarification_answered',
  session_id: string,
  cart_id: string,
  request_id: string,   // echo the request_id from order.clarification_needed
  answer: string
}
```
Resumes the paused order turn.

### `connection.resume` — reconnect and re-sync
```ts
{
  type: 'connection.resume',
  session_id: string,
  cart_id: string,
  last_seen_cart_version: number   // your last known cart.version
}
```
Replies with a `connection.resumed` snapshot (§4). State is held open for **60 s**
after a disconnect.

---

## 4. Outbound messages (gateway → client)

### `voice.partial_transcript` — live, display-only
```ts
{ type: 'voice.partial_transcript', session_id: string, text: string }
```
Live interim transcript for on-screen display, repeated as speech comes in.
Show it; don't act on it.

### `voice.final_transcript` — settled utterance, display-only
```ts
{ type: 'voice.final_transcript', session_id: string, text: string, language?: string }
```
The finalized transcript — replace the on-screen partial with this. Display-only;
the backend acts on its own copy, not on anything you echo back. `language` is the
detected language tag when available. A final that arrives after a
`final_transcript_timeout` is suppressed and never sent.

### `cart.updated` — authoritative cart state
```ts
{ type: 'cart.updated', cart_id: string, version: number, cart: Cart }
```
The single source of truth for cart contents — **render from this.** Broadcast to
**every** socket on the `cart_id` (multi-device / reconnect). `version` increases
monotonically; ignore an update whose `version` is ≤ your current one. `Cart` shape
in §5.

### `order.clarification_needed` — backend needs a decision
```ts
{
  type: 'order.clarification_needed',
  cart_id: string,
  request_id: string,       // echo back in order.clarification_answered
  question: string,
  options?: string[]        // present when the answer is a choice
}
```

### `order.suggestion_ready` — a spoken recommendation
When an utterance is a recommendation request (e.g. "what's good here?", "what do
you recommend?") rather than an order, the backend answers with a spoken suggestion
**instead of** writing the cart.
```ts
{
  type: 'order.suggestion_ready',
  cart_id: string,
  request_id: string,
  reply: string,            // the spoken recommendation — say it / show it
  items: SuggestedItem[]    // the real menu items the reply named (may be empty)
}

interface SuggestedItem {
  menu_item_key: string;    // stable menu key
  name: string;             // display name — render this
}
```
- **No cart write follows** a suggestion. `reply` is the whole payload to surface;
  `items` are the concrete menu items it named — safe to render, and may be empty.
- Acting on it ("add the first one", "I'll take that") is a normal follow-up
  utterance and yields a `cart.updated` on that next turn. `request_id` is a
  correlation id only — no echo required.

### `cart.operation_rejected` — a requested change was refused
```ts
{
  type: 'cart.operation_rejected',
  cart_id: string,
  request_id: string,
  reason: string,           // machine code
  message: string           // human-readable
}
```

### `voice.error` — voice/transcription problem
```ts
{ type: 'voice.error', session_id: string, reason: string, message: string }
```

| `reason` | Meaning | Client action |
|---|---|---|
| `bad_message` | Unparseable / unknown inbound message | Fix the payload; socket stays open |
| `stt_failed` | Transcription dropped or failed to open | Prompt user to repeat; may retry `voice.start` |
| `final_transcript_timeout` | No final transcript within 4 s of `voice.stop` | Ask user to repeat |

### `connection.resumed` — reconnect snapshot
```ts
{
  type: 'connection.resumed',
  session_id: string,
  cart_id: string,
  cart_version: number,
  cart: Cart,
  voice_session_status: string   // currently always 'idle'
}
```

---

## 5. Cart schema

All monetary values are **integer cents**.

```ts
interface Cart {
  cart_id: string;
  pos_config_id: number;
  version: number;
  items: CartLine[];
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  last_updated: string;   // ISO 8601
}

interface CartLine {
  line_id: string;              // stable line id (e.g. "ln_1")
  product_tmpl_id: number;      // menu item id
  product_id?: number;          // resolved variant, if known
  name: string;                 // display name (e.g. "Chicken Burger") — render this
  quantity: number;
  modifiers: CartModifier[];
  combo_id?: number;
  combo_choices?: number[];
}

interface CartModifier {
  ptav_id: number;              // modifier value id
  name: string;                 // display name (e.g. "No mayo") — render this
}
```

> **Names are a snapshot at add time.** `CartLine.name` / `CartModifier.name` are captured
> when the line/modifier is added. Render them directly (no menu lookup needed); they won't
> change if a menu item is later renamed.

---

## 6. Lifecycle

### Voice ordering turn (happy path)
```
  ── voice.start ──────────────▶
  ── voice.audio_chunk × N ────▶
  ◀── voice.partial_transcript ─  (live display, repeated)
  ── voice.stop ───────────────▶
  ◀── voice.final_transcript ──   settled utterance (replace the partial)
  ◀── cart.updated ────────────   new authoritative cart
```

If the backend needs a decision:
```
  ◀── order.clarification_needed ─   (question + optional options)
  ── order.clarification_answered ─▶
  ◀── cart.updated ───────────────   result
```

If the utterance is a recommendation request (not an order):
```
  ── voice.start / audio_chunk × N / voice.stop ─▶
  ◀── voice.final_transcript ───────────────────   settled utterance
  ◀── order.suggestion_ready ───────────────────   spoken reply + named items (NO cart write)
```
Acting on a suggestion ("add the first one") is just another voice turn, and that
one yields a `cart.updated`.

### Failure branches
- Transcription can't open / drops → `voice.error` `stt_failed`.
- `voice.stop` but no final within 4 s → `voice.error` `final_transcript_timeout`.
- Socket closes mid-utterance → the utterance is dropped and partials discarded,
  but the **cart is preserved** — reconnect with `connection.resume`.

### Reconnect
```
  (socket drops — state held 60s)
  ── connection.resume ────────▶
  ◀── connection.resumed ───────   full cart snapshot + voice_session_status
```

---

## 7. Client implementation notes

- **Render cart only from `cart.updated` / `connection.resumed`.** Treat `version`
  as a fence: apply an update only if its `version` is greater than what you hold.
- **Transcripts are cosmetic.** Both `voice.partial_transcript` and
  `voice.final_transcript` are display-only — show them, discard them.
- **Echo `request_id`** unchanged when answering `order.clarification_needed`, and
  use it to correlate `cart.operation_rejected`.
- **Suggestions are spoken, not cart writes.** `order.suggestion_ready` is never
  followed by a `cart.updated`. Acting on it is a normal follow-up utterance.
- **Money is integer cents** — divide by 100 for display; never send prices.
- **One session per socket.** `session_id` identifies the voice session; `cart_id`
  may span multiple sockets (multi-device) and receives broadcast cart updates.
- **On `4001` close**, the URL was missing required auth params — don't auto-retry
  without fixing them.
```