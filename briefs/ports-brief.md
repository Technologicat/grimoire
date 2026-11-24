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
- **The core is copied from Raven, never edited here.** `lorebookcore.py`, its conformance cases
  `lorebook_conformance.json` and their runner `test_lorebookcore.py` come from a Raven checkout by a sync
  script, which records the Raven commit they came from. A change to the core is made in Raven and synced.
  - **The runner is synced too** (maintainer, 2026-11-23), rather than kept as an adapted copy, which could fall
    behind a new field in the cases while still passing. Raven's runner imports the core relatively for this,
    and runs under pytest's importlib import mode, as grimoire does.
  - **The sync reads from a git ref, never from Raven's working tree** (2026-11-23): `git show <ref>:<path>`,
    defaulting to `origin/main` after a fetch. Raven's main tree is often mid-work in another session, dirty
    or behind, and a ref is also what makes the recorded commit true of what was copied.
  - **CI checks that the synced files are unedited** (maintainer, 2026-11-23): it fetches Raven at the
    recorded commit and byte-compares them, which turns the rule from a convention into a check.
- **Every implementation of the core runs the conformance cases in CI**: the Python copy, and the TypeScript
  translation. A translation that has fallen behind Raven fails there.
- **Python 3.11 is the floor**, the oldest version still supported (3.10 reached its end of life in October
  2026), and the core's own. The dev venv runs 3.14 (maintainer, 2026-11-23); CI covers 3.11 to 3.15.
- **The JS dev environment is chosen for how well the agent works in it** (maintainer, 2026-11-23), not for
  the fewest installs: an install costs little, and goes into `NEW-MACHINE-SETUP.md`. Chosen at step 4, when
  it is first needed.
- **The terms' inflected forms are read from Raven's ledgers**, where Raven runs on the same machine, and are
  never generated inside a hook. Generating them needs an LLM and takes minutes. The ledger format is
  Raven's [`sweep-ledger.md`](https://github.com/Technologicat/raven/blob/main/raven/librarian/sweep-ledger.md).
- **The name.** A grimoire is a book of true names, which is what a lorebook is to the model, and it nods to the
  glossary's own *True Name*. *rosetta*, one text in several scripts, was considered and passed over: it is the
  name of one of chandra's engines.

## What is known per frontend

The porting guide's *Hosts* section has it in full. In short:

- **Claude Code** (checked against the hooks, plugins and MCP docs at code.claude.com, 2026-11-23):
  - **Found in the docs:**
    - A `UserPromptSubmit` hook gets `session_id` and `prompt` on stdin, and gives the definitions as
      `hookSpecificOutput.additionalContext`. Its default timeout is 30 seconds.
    - **At most 10,000 characters per hook output**; over that, the output is replaced by a file path and a
      2,000-character preview. Taken as good enough (maintainer, 2026-11-23): the lookup tool is there, and the
      preview is context enough for the model to call it.
    - A `SessionStart` hook can match `compact`, and can return `additionalContext` too.
    - A plugin's MCP server starts when the plugin is enabled, and its tools reach the model as
      `mcp__plugin_<plugin>_<server>__<tool>`.
    - An install copies **only the plugin's directory** into a cache; a path above it is not copied, and is
      rejected. A symlink to elsewhere in the marketplace is dereferenced on a git install, but skipped on a
      local-path one.
    - A `marketplace.json` at the repository root can list a plugin at a relative path, `"./claude-code"`.
    - `userConfig` has a `directory` type, prompted for at enable; hooks get it as `CLAUDE_PLUGIN_OPTION_<KEY>`,
      MCP server config as `${user_config.KEY}`.
    - `${CLAUDE_PLUGIN_DATA}` is `~/.claude/plugins/data/<id>/`, kept across updates, removed on uninstall.
    - Nothing is said about which Python runs a hook; the port assumes `python3` on the path, 3.11 or later.
  - **Observed in a live install** from a local-path marketplace (2026-11-23):
    - The hook's definitions arrive as a system reminder, with the linked entries after them, and the session's
      record is written.
    - The MCP server's tool appears as `mcp__plugin_grimoire_lorebook__lorebook_lookup`, with no approval prompt.
    - A setting left empty is not stored, and reaches the MCP server as an empty string.
    - The plugin is copied to `cache/grimoire/grimoire/<12 hex digits of the commit>/`, but a local-path
      marketplace's plugin **runs from the repository, not the cache**, so that install does not exercise the
      copy.
    - **Installed from GitHub, it runs from the cache copy**, the hook and the MCP server alike, with the
      plugin's own copies of the core and the ledger reader.
    - **The version is the repository's latest commit**, not the plugin directory's: a commit touching only the
      brief made a new one. So any commit counts as an update.
    - Uninstalling removes the plugin's data folder, and with it every session's record.
  - **Decided** (maintainer, 2026-11-23):
    - **The plugin carries its own copy of the core**, written by the sync script and covered by `--check`,
      rather than a symlink, which a local-path install would skip.
    - **The MCP server is standard library only**, a small stdio JSON-RPC server, so that it runs on the same
      `python3` as the hooks and installs nothing.
    - **The forms come from every ledger in Raven's folder**, the newest answer whose digest matches the term as
      it is now winning for each term. Forms are read from every language; **stems are off by default, with a
      setting to turn them on** for the languages that want them.
    - **Only the prompt is scanned**, not the four messages before it as in Raven: the transcript's format is
      not documented, and it may lag. *Limitation, to document*: a term only in the model's last reply does
      not fire.
    - **After compaction the record is forgotten**, rather than the definitions given again: what a session
      was given can exceed one hook output. *Limitation, to document*: definitions given before compaction
      are given again only as their terms come up again, so until then the model has only the summary.
    - **The budget counts characters**: 8,000 per prompt, under the hook output's cap, and 32,000 per session.
- **Open WebUI** (read 2026-11-24 in its docs, and in its source at 0.13.4 where the docs are silent; the local AI
  server runs 0.13.3):
  - **Documented:**
    - A **Filter** function has four hooks. `inlet` runs once per user turn; `request`, new in 0.11.2, runs
      before *every* call to the model, each hop of a tool loop included, and "any change you make must be safe
      to apply to a body you have already changed". Both get `body["messages"]`, and "can modify it freely".
    - What the model receives is more than `body["messages"]`: the model's system prompt, RAG sources and, in
      native mode, memories and skills are added after `inlet`, and all system messages are merged into one.
    - A filter knows its chat: `__chat_id__` and `__metadata__["chat_id"]`. There is no documented per-chat store,
      and the `Filter` instance is cached and shared across requests.
    - **A function is one Python file, stored in the database** and loaded with `exec()`: pasted in the admin
      panel, imported from a URL (GitHub URLs converted to raw), or created through the admin API. Nothing loads
      from the filesystem. A `requirements:` line in the frontmatter pip-installs packages at first load.
    - Settings are pydantic **Valves** (admin) and **UserValves** (per user, from the chat's controls). A `str`
      valve serves for a folder path.
    - A **Tool** is a separate plugin kind, `class Tools`, every public method a tool. **Native function calling
      is the default**; the prompt-based mode is "Legacy" and unsupported. A tool is enabled per chat, or by
      default per model.
    - A filter can add tool specifications to `body["tools"]`, but nothing executes them.
    - The last breaking change to the plugin API was 0.9.0 (2026-04-20), the data layer turning async.
  - **Read in the source, not documented:**
    - **What a filter inserts is not stored**: the user's turn is stored before the filters run, and each turn's
      messages are rebuilt from the database. So an inserted round exists for that request only, and the filter
      will not see it on the next turn.
    - Inserted assistant `tool_calls` and `tool` messages are passed to a Chat Completions backend unchanged; the
      server's own check of tool pairs runs before the filters, so an inserted pair must be well-formed itself.
    - Functions and Tools are separate tables with separate loaders, so a filter and a tool are **two installs**.
      A model's call to a tool only a filter advertised gets "Tool not found".
  - **Deployment, on the local AI server:** Open WebUI runs in a podman container whose only mount is its data
    volume, started by two launchers, m97 and dotclaude's `open-webui-serve`. That machine has no lorebook folder
    and no ledgers yet; on this machine the lorebook folder holds a symlink into `substrate-independent`, which a
    container would not resolve unless the target is mounted too.
  - **Needs a live test**: an inserted tool round before the user's message reaching the backend intact, and
    gufo accepting it; the `request` hook seeing its own insertion on a later hop; the Tool reading a folder path
    from its valve.
- **pi**: an extension's `before_agent_start` can store a typed message in the session and send it to the model,
  the nearest thing to Raven's stored round; `pi.registerTool` offers the lookup. Recognizing its own messages
  on the branch is inferred, **to verify**.
- **LM Studio**: the preprocessor can only prepend to the user's message, so the port marks what it injects.

## Order of work

1. **The repository's bones**: the sync script and the synced core, and CI running the conformance cases on it.
2. **Claude Code**: the two hooks, the per-session record, reading Raven's ledgers, and the lookup tool.
3. **The ledger generator**, for a machine without a runnable Raven.
4. **Open WebUI**.
5. **The TypeScript core**, passing the conformance cases.
6. **pi**, then **LM Studio**.

## The ledger generator

**Without the inflected forms a term fires only as written**, and listing the forms as aliases by hand is what
users will not do (maintainer, 2026-11-23). Not every machine has a runnable Raven to generate them, so grimoire
carries a generator of its own, which every port's users can run.

- **grimoire's own code, writing Raven's format** (maintainer, 2026-11-23): standard library only, asking any
  OpenAI-compatible endpoint, writing ledgers as `sweep-ledger.md` describes, so Raven reads them too. Ten terms
  per batch, resumable, keeping the complete terms of a reply that runs on.
- **The prompt, `raven/librarian/prompts/lorebook_expansion.md`, is synced from Raven** with the core.
- **Installed with pipx** (maintainer, 2026-11-24), as `grimoire-expand`, so that it runs on any machine without
  knowing the repository's layout. Built with hatchling, which PDM drives like any backend.
- **First run** (2026-11-24): `flash-next` on gufo, the 90-entry glossary, English forms and Finnish stems, 91
  terms in ten batches, none failed. The ledger's fingerprint is the one Raven computes, checked against Raven's
  code. English inflections fire; the Finnish answers are weaker, the model's and the prompt's doing rather than
  grimoire's: "lift" got no Finnish forms, "ethnography" got its translation's. Improving them is Raven's prompt
  work.
- **Rejected: moving the generator's pure parts into Raven's portable layer**, to be synced rather than
  reimplemented. Measured 2026-11-23, they come to about 100 lines, mostly fully specified by `sweep-ledger.md`
  and the porting guide, against a driver grimoire would write regardless at two to three times that, since
  Raven's own driver runs on `llmclient` and `sweep.Sweep`. The leverage did not pay for a refactor across two
  Raven modules and a second conformance file.

## Open questions

- Which Raven commit a release of grimoire pins its core to, and how often to sync.
- Whether the TypeScript ports share one package, or each carries the core.
