---
type: Index
title: tts bundle
description: Synthesizes the agent's spoken replies with Deepgram and streams audio to the client.
timestamp: 2026-07-14
---

# tts

Turns each `order.reply` into streamed speech: the Realtime Gateway drives
`TtsService`, which calls a `TtsProvider` (Deepgram Aura) and pushes `tts.*` audio
frames (base64 in JSON) back over the client socket. Covers `src/tts/`.

- [overview.md](./overview.md) — purpose, mechanics, dependencies, files.
