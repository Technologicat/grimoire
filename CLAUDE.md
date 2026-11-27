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
conformance cases `lorebook_conformance.json` and their runner `test_lorebookcore.py`. So is the Claude Code
plugin's own copy of the core, `claude-code/scripts/lorebookcore.py`, which an installed plugin needs because
only the plugin's directory is copied on install. A change to any of them is
made in Raven, under `raven/librarian/`, and then synced with `python scripts/sync_core.py`, which records the
Raven commit in `core/RAVEN_COMMIT`. An edit made here would be lost at the next sync, and CI fails on it:
`scripts/sync_core.py --check` compares the copies against Raven at the recorded commit.

The TypeScript translation is grimoire's own, and is checked against the same conformance cases. One part of it is
generated: its table of math symbols, `MATH_SYMBOLS` in `ts/core/src/lorebookcore.ts`, which the sync script
regenerates from the Python core's `_MATH_SYMBOLS`, and `--check` holds to it.

## Shared modules are edited in `lib/`

**grimoire's own code shared between ports lives in `lib/`**, and a port that is installed by copying its own
directory carries a copy, written by the same sync script: `claude-code/scripts/ledger.py` is `lib/ledger.py`.
Edit the one in `lib/`, then run `python scripts/sync_core.py`; `--check` fails on a copy that differs from
its source. The same holds for the LM Studio plugin's `lmstudio/src/core/`: copies of `ts/core/src/`, since LM Studio
builds a plugin from its own folder alone. Tests for `lib/` are in `lib/tests/`, and import the modules side by side with the core, as a
port's copies sit.

## The Open WebUI plugins are generated

**`open-webui/grimoire_filter.py` and `grimoire_tool.py` are built, never edited**: Open WebUI keeps each plugin as
one file, so `python scripts/build_open_webui.py` inlines the core, `lib/ledger.py` and the port's sources in
`open-webui/src/` into each. Edit the sources, build, and commit the result; a test fails on a generated file
that is not current. The build stops on a top-level name defined in two of the inlined modules.

## Status

All six steps of the brief are built: the sync script, the synced core, and CI running the
conformance cases and checking the copies; the Claude Code plugin, tested live from GitHub; the ledger generator,
`grimoire-expand`, installed with pipx; the Open WebUI filter and tool, tested live on the local AI server; the
TypeScript core and ledger reader, held to the same conformance cases; and the pi extension and the LM Studio
plugin, both tested live. The brief's order of work is done; what remains is in its open questions and project
hygiene.
