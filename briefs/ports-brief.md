# Brief: the Raven lorebook in other frontends

A lorebook gives an LLM the definitions of the user's own terms when a term comes up in the conversation: a
folder of Markdown files, each entry a section whose header is the term. Raven-librarian has one. **grimoire
gives the same lorebook to the other frontends in use**, so that one folder of definitions serves them all.

Raven made the lorebook portable for this (2026-11-23), and its
[porting guide](https://github.com/Technologicat/raven/blob/main/raven/librarian/lorebook-porting.md) is the
reference for what a port takes and what its host supplies. This brief is the plan for the ports themselves.

## The frontends

In order of building:

1. **Claude Code**, as a plugin. The cheapest, and the one in daily use: it saves the agent a manual lookup
   whenever a glossary term comes up.
2. **Open WebUI**, as a filter function. In use on the local AI server.
3. **pi** (`pi.dev`), as an extension.
4. **LM Studio**, as a prompt preprocessor plugin, for working on the road.

Claude Code and Open WebUI are Python, so Raven's core goes into both as it is. pi and LM Studio are
TypeScript, so one translation of the core serves both.

## Decisions

- **One repository for all the ports** (maintainer, 2026-11-23): a repository per frontend would be three or
  four to keep in step with Raven, where one is enough. Raven itself was ruled out as the home, as the
  TypeScript ports would bring npm, a compiler and a test runner into its CI for code it does not run. Plugin
  installers generally expect a repository root, which is a second reason; not yet checked for Claude Code,
  whose marketplaces may accept a subdirectory.
- **Every port offers the lookup tool**, `lorebook_lookup`, as well as giving definitions as terms come up
  (maintainer, 2026-11-23). A model asking for a term that was not given happens on every host, and on a local
  model the definitions are safest given as a tool round, which presumes the tool: Raven measured that shape
  as the only one working across the local models tested.
- **The core is copied from Raven, never edited here.** `lorebookcore.py` and its conformance cases,
  `lorebook_conformance.json`, come from a Raven checkout by a sync script, which records the Raven commit
  they came from. A change to the core is made in Raven and synced.
- **Every implementation of the core runs the conformance cases in CI**: the Python copy, and the TypeScript
  translation. A translation that has fallen behind Raven fails there.
- **Python 3.11 is the floor**, the oldest version still supported (3.10 reached its end of life in October
  2026), and the core's own.
- **The terms' inflected forms are read from Raven's ledgers**, where Raven runs on the same machine, and are
  never generated inside a hook. Generating them needs an LLM and takes minutes. The ledger format is
  Raven's [`sweep-ledger.md`](https://github.com/Technologicat/raven/blob/main/raven/librarian/sweep-ledger.md).
- **The name.** A grimoire is a book of true names, which is what a lorebook is to the model, and it nods to the
  glossary's own *True Name*. *rosetta*, one text in several scripts, was considered and passed over: it is the
  name of one of chandra's engines.

## What is known per frontend

The porting guide's *Hosts* section has it in full. In short:

- **Claude Code** (checked against the hooks and plugins references, 2026-11-23):
  - A `UserPromptSubmit` hook gives the definitions as `additionalContext`, at most 10,000 characters per output.
  - A `SessionStart` hook matching `compact` gives them again after compaction, which summarizes them away.
  - The record of what was given lives in `${CLAUDE_PLUGIN_DATA}`, keyed by the session id.
  - The folder is a `userConfig` setting of type `directory`.
  - **To verify before building**: that a plugin's MCP server gives the model a callable lookup tool.
- **Open WebUI**: Python. Its filters are recalled to be able to change a conversation before the model sees
  it; **to verify**.
- **pi**: an extension's `before_agent_start` can store a typed message in the session and send it to the model,
  the nearest thing to Raven's stored round; `pi.registerTool` offers the lookup. Recognizing its own messages
  on the branch is inferred, **to verify**.
- **LM Studio**: the preprocessor can only prepend to the user's message, so the port marks what it injects.

## Order of work

1. **The repository's bones**: the sync script and the synced core, and CI running the conformance cases on it.
2. **Claude Code**: the two hooks, the per-session record, reading Raven's ledgers, and the lookup tool.
3. **Open WebUI**.
4. **The TypeScript core**, passing the conformance cases.
5. **pi**, then **LM Studio**.

## Open questions

- How a Claude Code marketplace lays out a plugin in a repository that holds other things.
- Which Raven commit a release of grimoire pins its core to, and how often to sync.
- Whether the TypeScript ports share one package, or each carries the core.
