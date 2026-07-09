# Realtime Gateway — Frontend Integration

How the mobile/web client talks to the backend. **One WebSocket per app carries
both voice and cart traffic.** The client streams microphone audio up, receives
live partial transcripts, the settled final transcript, and cart state down. All
messages are JSON text frames (there are **no** binary frames — audio is base64
inside JSON).

Source of truth for the contracts below:
- Transport / connection — `src/realtime/websocket-server.ts`
- Auth — `src/auth/session-auth.ts`, `src/auth/auth-types.ts`
- Message schemas — `src/realtime/realtime-message-types.ts`
- Routing — `src/realtime/message-router.ts`, `src/realtime/realtime-gateway.ts`
- Voice/STT handling — `src/voice/voice-message-handler.ts`
- Cart shape — `src/cart/cart-types.ts`
- Tunables — `src/config/constants.ts`, `src/config/env.ts`

---

## 1. Connection

### Endpoint

| | |
|---|---|
| **WebSocket path** | `/ws` |
| **Host / port** | Same HTTP server as health; port from `PORT` (default **3000**) |
| **Example** | `ws://<host>:3000/ws?session_id=…&cart_id=…&pos_config_id=…` |
| **Health check** | `GET /health` or `GET /healthz` (plain HTTP, same port) |

### Auth (query string on the upgrade URL)

Authentication params ride on the connection URL's query string
(`src/realtime/websocket-server.ts` → `paramsFromUrl`, `src/auth/session-auth.ts`):

| Param | Type | Required | Notes |
|---|---|---|---|
| `session_id` | string | ✅ | Voice session id, e.g. `voice_session_123` |
| `cart_id` | string | ✅ | Globally unique; the Redis cart key. e.g. `cart_456` |
| `pos_config_id` | integer | ✅ | The Odoo POS / "restaurant" id |
| `token` | string | ⚠️ | Accepted but **not yet verified** — auth is a stub (`TODO: verify a signed token`) |

If `session_id`, `cart_id`, or `pos_config_id` is missing, the server closes the
socket immediately with **close code `4001`** (reason `"unauthenticated"`).
`pos_config_id` must parse as an integer.

> **Stub warning:** `authenticate()` currently trusts the query params verbatim.
> `token` is parsed but ignored. Do not treat this as secure yet — a real signed-token
> check and POS lookup are TODO.

### Heartbeat / liveness

The server drives a ping/pong heartbeat (`src/config/constants.ts` → `TIMEOUTS`):

- Server sends a WS `ping` every **15 s** (`heartbeatIntervalMs`).
- A socket that misses a ping (no `pong` before the next tick) is **terminated**.
- Effective dead-socket threshold is **30 s** (`heartbeatTimeoutMs`).

Clients only need to let their WS library answer pings automatically (browsers and
`ws` do this natively). No application-level heartbeat message exists.

---

## 2. Message envelope

Every message is a JSON object with a `type` discriminator. Types are namespaced
`voice.*`, `order.*`, `cart.*`, `connection.*`.

Inbound decoding (`parseInbound`) is **trust-but-verify**: an unknown or
non-JSON message yields a `voice.error` with `reason: "bad_message"`; it does not
close the socket.

Shared id types (`src/shared/types.ts`): `session_id`, `cart_id`, `request_id` are
opaque **strings**; `pos_config_id` and all Odoo ids are **integers**.

---

## 3. Inbound messages (client → gateway)

Defined in `src/realtime/realtime-message-types.ts` (`InboundMessage` union).

### `voice.start` — begin an utterance
Opens the STT stream. Must be sent before any audio chunk.
```ts
{ type: 'voice.start', session_id: string, cart_id: string }
```

### `voice.audio_chunk` — stream mic audio
```ts
{
  type: 'voice.audio_chunk',
  session_id: string,
  seq: number,        // monotonically increasing chunk index
  audio: string       // base64-encoded PCM16 (little-endian) frame
}
```
**Audio format** (`src/config/env.ts`, `src/voice/voice-message-handler.ts`):
- Encoding: **PCM16** (16-bit signed, mono), base64 in the `audio` field. Decoded
  server-side via `Buffer.from(audio, 'base64')`.
- Sample rate: **16 000 Hz** by default (`STT_SAMPLE_RATE`, `config.sttSampleRate`).
  Match this rate on the client.
- Chunks sent before `voice.start` (or after `voice.stop` / a terminal session) are
  silently dropped.
- The comment notes `PCM/opus` as possibilities, but the wired STT path decodes raw
  PCM16 — send PCM16 unless the STT provider config is changed.

### `voice.stop` — end of speech
```ts
{ type: 'voice.stop', session_id: string }
```
Flushes the STT stream and starts a **4 s** grace window (`finalTranscriptMs`) for
the final transcript. If no final arrives in that window, the client receives a
`voice.error` with `reason: "final_transcript_timeout"`. Repeat/concurrent
`voice.stop` messages are ignored.

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
Resumes the paused order-understanding turn on the backend.

### `connection.resume` — reconnect and re-sync
```ts
{
  type: 'connection.resume',
  session_id: string,
  cart_id: string,
  last_seen_cart_version: number   // client's last known cart.version
}
```
Replies with a `connection.resumed` snapshot (§5). The backend holds cart/session
state open for **60 s** after a disconnect (`reconnectWindowMs`).

---

## 4. Outbound messages (gateway → client)

Defined in `src/realtime/realtime-message-types.ts` (`OutboundMessage` union).

### `voice.partial_transcript` — live, display-only
```ts
{ type: 'voice.partial_transcript', session_id: string, text: string }
```
Live interim transcript for on-screen display. **Never** re-enters the backend
order flow — do not act on it beyond showing it. Sent directly by the Voice module.

### `voice.final_transcript` — settled utterance, display-only
```ts
{ type: 'voice.final_transcript', session_id: string, text: string, language?: string }
```
The finalized transcript for the utterance — replace the on-screen partial with this.
Like the partial, it is **display-only**: the backend acts on its own internal copy
(feeding order understanding), never on anything the client echoes back. Sent directly
by the Voice module once STT settles the turn (typically right after `voice.stop`).
A final that arrives after the session already went terminal (see
`final_transcript_timeout`) is suppressed and never sent. `language` is the detected
BCP-47-ish language tag when the STT provider reports one.

### `cart.updated` — authoritative cart state
```ts
{ type: 'cart.updated', cart_id: string, version: number, cart: Cart }
```
Broadcast to **every** socket on the `cart_id` (multi-device / reconnect). `version`
increases monotonically; ignore an update whose `version` is ≤ your current one.
This is the single source of truth for cart contents — render from it. `Cart` shape
in §6.

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

### `voice.error` — voice/STT problem
```ts
{ type: 'voice.error', session_id: string, reason: string, message: string }
```
`reason` values (from `voice-message-handler.ts` / gateway):

| `reason` | Meaning | Client action |
|---|---|---|
| `bad_message` | Unparseable / unknown inbound message | Fix the payload; socket stays open |
| `stt_failed` | STT disconnected or failed to open | Prompt user to repeat; may retry `voice.start` |
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

From `src/cart/cart-types.ts`. All monetary values are **integer cents**.

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
  line_id: string;              // stable, assigned by the Cart Module (e.g. "ln_1")
  product_tmpl_id: number;      // Odoo product_template.id (menu item)
  product_id?: number;          // resolved sellable variant, if known
  name: string;                 // display name (e.g. "Chicken Burger") — render this
  quantity: number;
  modifiers: CartModifier[];
  combo_id?: number;
  combo_choices?: number[];     // product_product ids
}

interface CartModifier {
  ptav_id: number;              // product_template_attribute_value.id
  name: string;                 // display name (e.g. "No mayo") — render this
}
```

> **Names are a snapshot at add time.** `CartLine.name` / `CartModifier.name` are captured
> from the menu when the line/modifier is added and stored on the cart. They are safe to render
> directly (no separate menu lookup needed) but will not change if a menu item is later renamed.

---

## 6. Lifecycle

### Voice ordering turn (happy path)
```
Client                         Gateway / Voice
  │  ── voice.start ──────────────▶  open STT stream
  │  ── voice.audio_chunk × N ───▶  feed audio
  │  ◀── voice.partial_transcript ─  (live display, repeated)
  │  ── voice.stop ──────────────▶  flush stream, start 4s grace
  │  ◀── voice.final_transcript ──  settled utterance (replace the partial)
  │                                 final transcript → order understanding → cart write
  │  ◀── cart.updated ────────────  new authoritative cart
```

If understanding needs a decision:
```
  │  ◀── order.clarification_needed ─  (question + optional options)
  │  ── order.clarification_answered ─▶  resume turn
  │  ◀── cart.updated ────────────────  result
```

### Failure branches
- STT can't open / drops → `voice.error` `stt_failed`.
- `voice.stop` but no final within 4 s → `voice.error` `final_transcript_timeout`.
- Socket closes mid-utterance → session is dropped, partials discarded, **cart is
  preserved**; on reconnect use `connection.resume`.

### Reconnect
```
  (socket drops — backend holds state 60s)
  │  ── connection.resume ────────▶  look up cart
  │  ◀── connection.resumed ───────  full cart snapshot + voice_session_status
```

---

## 7. Client implementation notes

- **Render cart only from `cart.updated` / `connection.resumed`.** Treat `version`
  as a fence: apply an update only if its `version` is greater than what you hold.
- **Transcripts are cosmetic.** Both `voice.partial_transcript` and
  `voice.final_transcript` are display-only — show them, discard them. The backend
  acts only on its own internal final transcript, never on anything the client holds.
- **Echo `request_id`** unchanged when answering `order.clarification_needed` and
  when correlating `cart.operation_rejected`.
- **Money is integer cents** — divide by 100 for display; never send prices.
- **One session per socket.** `session_id` identifies the voice session;
  `cart_id` may span multiple sockets (multi-device) and receives broadcast updates.
- **On `4001` close**, the connection URL was missing required auth params — do not
  auto-retry without fixing them.
```

