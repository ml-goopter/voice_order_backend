# CLAUDE.md

## Knowledge base maintenance

This repo keeps a knowledge base under `.claude/.knowledge/`. Its structure:

```
knowledge/
├── index.md              # Top-level directory listing of every module bundle.
├── log.md                # Chronological history of codebase changes.
└── <module>/              # One bundle per module.
    ├── index.md          # The module's bundle listing (links to its concepts).
    └── overview.md       # The module concept: purpose, mechanics, deps, files.
```

Every `.md` file carries YAML frontmatter (fenced by `---`) whose FIRST key is
the required `type` (e.g. `Index`, `Concept`), optionally followed by `title`,
`description`, `resource`, `tags`, and `timestamp`.

Whenever you make changes to the codebase, you MUST update the knowledge base as
part of the same change (same commit/PR as the code):

### `knowledge/log.md` — chronological change log

Append a new entry for every meaningful code change. Do not rewrite or reorder
existing entries. Newest entries go at the top.

Format each entry as:

```
## YYYY-MM-DD — <short title>
- **What:** one-line summary of the change.
- **Why:** the reason or problem being solved.
- **Where:** affected module(s)/module(s)/file(s).
- **Notes:** migrations, config, or follow-ups a future reader needs. (optional)
```

Use today's date. Group related edits from a single task into one entry rather
than one entry per file.

### module bundles — durable map of the codebase

The per-module bundles are not chronological — edit them in place so they always
reflect the present state. When a change touches an module, keep its bundle
current:

- **Edit `knowledge/<module>/overview.md`** whenever behavior, mechanics, models,
  dependencies, or key files change — keep its sections accurate.
- **Edit `knowledge/<module>/index.md`** if the bundle's description or its list
  of concept files changes.
- **New module** → create `knowledge/<module>/` with `index.md` + `overview.md`
  (copy the frontmatter and section layout of an existing bundle), then add a
  line for it to the top-level `knowledge/index.md`.
- **Removed/renamed module** → update/remove its bundle and its line in the
  top-level `knowledge/index.md`.

Skip bundle edits for changes that don't alter an module's documented behavior or
structure (internal bug fixes, small tweaks) — those only go in `log.md`.

### When to skip

- Trivial, non-code changes (typos in comments, formatting) need no entry.
- If a change is purely internal and affects no behavior or structure, a
  `log.md` line is enough; the bundles can stay as is.

When in doubt, add a short `log.md` entry — an over-recorded log is cheaper than
a missing one.

### DO NOT READ .env under any circumstances