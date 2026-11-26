# grimoire for pi

Gives the model the definitions of your own terms when a term comes up in the conversation, from a lorebook: a
folder of Markdown files, each entry a section whose header is the term. The same folder serves
[Raven](https://github.com/Technologicat/raven)-librarian and grimoire's other ports.

An extension for [pi](https://pi.dev), 1.6 or later.

## Install

```
pi install git:github.com/Technologicat/grimoire
```

It reads the lorebook and the inflected forms from Raven's folders, so on a machine where Raven keeps them it needs
no setup. To read them from elsewhere, write `~/.pi/agent/grimoire.json`; every key is optional:

```json
{
  "lorebookDir": "~/.config/raven/librarian/lorebook",
  "ledgerDir": "~/.config/raven/librarian/lorebook_expansion",
  "stemLanguages": ["Finnish"],
  "budget": 8000
}
```

- **`lorebookDir`**: your definitions.
- **`ledgerDir`**: where the terms' inflected forms are read from.
- **`stemLanguages`**: languages that inflect too much to list every form, matched by stem as well. None by default.
- **`budget`**: the most characters of definitions given with one message.

**For terms to match however they are inflected**, generate their inflected forms once, with Raven or with
grimoire's `grimoire-expand` ([grimoire's README](../README.md#inflected-forms)). Without them, a term matches only
as written in the lorebook.

**To check it works**, mention a term from your lorebook: the footer says how many definitions the model was given,
and `/lorebook` names them.

## What it does

**Before each call to the model, the definitions of the terms in your message and the four messages before it are
added**, as answers to `lorebook_lookup` calls the model did not make, just before your message, with the entries
their definitions link to, up to two links deep.

- **They are not stored in the session.** They are made afresh for each call, from the conversation as it stands.
- **The folder is read again at every call**, so an edited definition is used at once.

**The model can also look a term up**, with the `lorebook_lookup` tool, for one whose definition was not given: it
gets the entry, a near miss taken as meant, the entries that mention the term, or a plain "not defined".

## Limitations

- **A term mentioned only earlier than the last five messages is no longer defined**, unless it comes up again, or
  the model looks it up.
- **At most `budget` characters of definitions per message.** Past that, the remaining ones are not given.
