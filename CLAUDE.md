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

**`lorebookcore.py` and `lorebook_conformance.json` are copies, never edited here.** A change to the core is
made in Raven, `raven/librarian/lorebookcore.py`, with its conformance cases updated there, and then synced. An
edit made here would be lost at the next sync, and would make this copy disagree with the cases it is tested
against without anyone noticing.

The TypeScript translation is grimoire's own, and is checked against the same conformance cases.

## Status

Planning: nothing is built yet. The order of work is in the brief.
