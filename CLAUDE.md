# CLAUDE.md

Guidance for Claude Code working in this repository. Fleet-wide conventions live in the global
`~/.claude/CLAUDE.md`; this file holds only what is specific to grimoire.

## What grimoire is

Raven's lorebook, ported to other LLM frontends: Claude Code, Open WebUI, pi and LM Studio. The plan, the
decisions behind it, and what is known about each frontend are in
[`briefs/ports-brief.md`](briefs/ports-brief.md). Raven's
[porting guide](https://github.com/Technologicat/raven/blob/main/raven/librarian/lorebook-porting.md) is the
reference for what a port takes and what its host supplies.

## The core is Raven's

**Everything under `core/` is a copy, never edited here**: `lorebookcore.py`, and in `core/tests/` its
conformance cases `lorebook_conformance.json` and their runner `test_lorebookcore.py`. A change to any of them is
made in Raven, under `raven/librarian/`, and then synced with `python scripts/sync_core.py`, which records the
Raven commit in `core/RAVEN_COMMIT`. An edit made here would be lost at the next sync, and CI fails on it:
`scripts/sync_core.py --check` compares the copies against Raven at the recorded commit.

The TypeScript translation is grimoire's own, and is checked against the same conformance cases.

## Status

Planning: nothing is built yet. The order of work is in the brief.
