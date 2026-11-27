# grimoire for Claude Code

Gives Claude the definitions of your own terms when a term comes up in the conversation, from a lorebook: a
folder of Markdown files, each entry a section whose header is the term. The same folder serves
[Raven](https://github.com/Technologicat/raven)-librarian and grimoire's other ports.

## Install

In Claude Code:

```
/plugin marketplace add Technologicat/grimoire
/plugin install grimoire@grimoire
```

On Claude Code 2.1.275 or later, one line does both: `/plugin install grimoire --marketplace Technologicat/grimoire`.

Claude Code asks for the settings when the plugin is enabled:

- **Lorebook folder**: your definitions. Required.
- **Inflected forms folder**: where the terms' inflected forms are read from. Empty means Raven's own,
  `~/.config/raven/librarian/lorebook_expansion`.
- **Languages matched by stem**: comma-separated, such as `Finnish, Estonian`, for languages that inflect too
  much to list every form. Empty means whole-word forms only.

The hooks and the lookup tool's server run `python3`, which has to be Python 3.11 or later. Nothing else is
installed.

**For terms to match however they are inflected**, generate their inflected forms once, with Raven or with
grimoire's `grimoire-expand` ([grimoire's README](../README.md#inflected-forms)). The plugin works without them,
matching each term only as written.

**To check it works**, start a new session and mention a term from your lorebook: its definition reaches Claude
with your message.

### Updating and removing

- **Update** with `/plugin update grimoire@grimoire`, or from the plugin manager, `/plugin`. Automatic updates are
  off by default for marketplaces other than Anthropic's.
- **Change the settings** from the plugin manager, `/plugin`, under grimoire.
- **Remove** with `/plugin uninstall grimoire@grimoire`. This also deletes the plugin's data folder, which holds
  only the record of what each session was given.

## What it does

**When you send a message, the definitions of the terms in it are added for Claude to read**, together with the
entries their definitions link to, up to two links deep. Each entry is given once per session, unless you edit
it: then it is given again when its term next comes up, with a note that it changed.

- **Inflected forms** match only if the inflected forms folder has them: Raven generates them with an LLM and
  keeps them in ledgers there. Without them, a term matches only as it is written in the lorebook, so "hydra
  taxes" does not match *hydra tax*.
- **A folder that changes is read again at the next message**, so an edited definition is used at once.

**Claude can also look a term up**, with the `lorebook_lookup` tool, for one whose definition was not given: it
gets the entry, a near miss taken as meant, the entries that mention the term, or a plain "not defined".
- **What each session was given** is kept in the plugin's data folder, and removed when the session has not been
  used for 30 days.

## Limitations

- **Only your message is scanned.** A term that appears only in Claude's last reply does not bring its definition.
  Claude used the term, so it likely knows it already.
- **After compaction, earlier definitions come back only as their terms come up again.** Compaction summarizes
  them away, and grimoire then forgets it gave them, rather than giving them all again at once, since everything
  a long session was given would not fit in one hook's output.
- **At most 8,000 characters of definitions per message, and 64,000 per session.** Past those, the remaining
  definitions are not given.
