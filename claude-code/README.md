# grimoire for Claude Code

Gives Claude the definitions of your own terms when a term comes up in the conversation, from a lorebook: a
folder of Markdown files, each entry a section whose header is the term. The same folder serves
[Raven](https://github.com/Technologicat/raven)-librarian and grimoire's other ports.

## Install

```
/plugin install grimoire --marketplace Technologicat/grimoire
```

Claude Code asks for the settings when the plugin is enabled:

- **Lorebook folder**: your definitions. Required.
- **Inflected forms folder**: where the terms' inflected forms are read from. Empty means Raven's own,
  `~/.config/raven/librarian/lorebook_expansion`.
- **Languages matched by stem**: comma-separated, such as `Finnish, Estonian`, for languages that inflect too
  much to list every form. Empty means whole-word forms only.

The hooks run `python3`, which has to be Python 3.11 or later. Nothing else is installed.

## What it does

**When you send a message, the definitions of the terms in it are added for Claude to read**, together with the
entries their definitions link to, up to two links deep. Each entry is given once per session.

- **Inflected forms** match only if the inflected forms folder has them: Raven generates them with an LLM and
  keeps them in ledgers there. Without them, a term matches only as it is written in the lorebook, so "hydra
  taxes" does not match *hydra tax*.
- **A folder that changes is read again at the next message**, so an edited definition is used at once.
- **What each session was given** is kept in the plugin's data folder, and removed when the session has not been
  used for 30 days.

## Limitations

- **Only your message is scanned.** A term that appears only in Claude's last reply does not bring its definition.
  Claude used the term, so it likely knows it already.
- **After compaction, earlier definitions come back only as their terms come up again.** Compaction summarizes
  them away, and grimoire then forgets it gave them, rather than giving them all again at once, since everything
  a long session was given would not fit in one hook's output.
- **At most 8,000 characters of definitions per message, and 32,000 per session.** Past those, the remaining
  definitions are not given.
