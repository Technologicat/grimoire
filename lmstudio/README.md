# grimoire for LM Studio

Gives the model the definitions of your own terms when a term comes up in the conversation, from a lorebook: a
folder of Markdown files, each entry a section whose header is the term. The same folder serves
[Raven](https://github.com/Technologicat/raven)-librarian and grimoire's other ports.

A plugin for [LM Studio](https://lmstudio.ai). Plugins are in beta in LM Studio, and their API may change.

## Install

From a checkout of grimoire, with LM Studio running:

```
cd lmstudio
lms dev --install
```

It reads the lorebook and the inflected forms from Raven's folders, so on a machine where Raven keeps them it needs
no setup. The plugin's settings in LM Studio:

- **For all chats:**
  - **Lorebook folder**: your definitions. Empty means Raven's, `~/.config/raven/librarian/lorebook`.
  - **Inflected forms folder**: where the terms' inflected forms are read from. Empty means Raven's,
    `~/.config/raven/librarian/lorebook_expansion`.
  - **Languages matched by stem**: languages that inflect too much to list every form. None by default.
  - **Characters per message** and **per chat**: how much of the lorebook is given, 8,000 and 64,000 by default.
- **Per chat:** **Lorebook**, on or off.

**For terms to match however they are inflected**, generate their inflected forms once, with Raven or with
grimoire's `grimoire-expand` ([grimoire's README](../README.md#inflected-forms)). Without them, a term matches only
as written in the lorebook.

## What it does

**When you send a message, the definitions of the terms in it and in the four messages before it go into your
message, before its text**, between markers, with the entries their definitions link to, up to two links deep.
LM Studio keeps your message as rewritten, so the definitions stay in the chat, and each is given once per chat,
unless you edit it: then it is given again when its term next comes up, with a note that it changed.

**In the chat** (as of LM Studio 0.4.29), your message shows as you typed it, the definitions given are named in a
status line under the answer, and LM Studio sends the model the rewritten message. Regenerating an answer rewrites
your message afresh, so its definitions are not given twice.

**The model can also look a term up**, with the `lorebook_lookup` tool, for one whose definition was not given: it
gets the entry, a near miss taken as meant, the entries that mention the term, or a plain "not defined".

## Limitations

- **The definitions are part of your message**, as LM Studio allows a plugin nothing else: they come before your
  question rather than as the answer to a lookup, which is how grimoire's other ports give them where they can.
- **At most 8,000 characters of definitions per message, and 64,000 per chat**, by default. Past those, the
  remaining definitions are not given.

## Developing

The lorebook's core is copied into `src/core/` from grimoire's `ts/core/src/` by `scripts/sync_core.py`, since LM
Studio builds a plugin from its own folder alone; edit it there, and sync.
