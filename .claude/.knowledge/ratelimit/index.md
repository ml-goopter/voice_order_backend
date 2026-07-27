---
type: Index
title: ratelimit bundle
description: Proactive rate shaping for every outbound third-party API call.
timestamp: 2026-07-27
---

# ratelimit

Token buckets, a concurrency semaphore, and a per-quota registry sitting inside the
STT/TTS/LLM/embedding provider adapters. Shapes outbound load *before* a provider
rejects it, rather than reacting to a 429 after the fact.

Ships dark: every limit defaults to `0` = unlimited, which resolves to a shared
no-op limiter with zero allocation and zero timers.

Policy and vendor evidence: `docs/plans/rate-limiting-policy.md`.

- [overview.md](./overview.md) — purpose, mechanics, dependencies, files.
