---
type: Index
title: llm bundle
description: Cloud LLM abstraction and prompt building for the order parser.
timestamp: 2026-07-07
---

# llm

Wraps the cloud LLM that parses transcripts into operations (design §8). Builds a
controlled prompt (transcript + cart + candidates + allowed ops) — never the full
menu.

- [overview.md](./overview.md) — purpose, mechanics, dependencies, files.
