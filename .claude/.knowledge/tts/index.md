---
type: Index
title: tts bundle
description: Synthesizes the agent's spoken replies with Cartesia and streams audio to the client.
timestamp: 2026-07-14
---

# tts

Turns each `order.reply` into streamed speech: the Realtime Gateway drives
`TtsService`, which calls a `TtsProvider` (Cartesia Sonic) and pushes `tts.*` audio
frames (base64 in JSON) back over the client socket. The reply's detected language is
forwarded so a multilingual voice speaks it in the customer's language. Covers `src/tts/`.

- [overview.md](./overview.md) — purpose, mechanics, dependencies, files.
