# grimoire for Open WebUI

Gives the model the definitions of your own terms when a term comes up in the conversation, from a lorebook: a
folder of Markdown files, each entry a section whose header is the term. The same folder serves
[Raven](https://github.com/Technologicat/raven)-librarian and grimoire's other ports.

Two plugins, each one file:

- **`grimoire_filter.py`**, a filter function: gives the definitions.
- **`grimoire_tool.py`**, a tool: lets the model look up a term whose definition was not given.

Needs Open WebUI 0.11.2 or later, and native function calling, which is Open WebUI's default.

## Install

Both are installed by an admin. Like every Open WebUI plugin, they run as code on the server, so read them first:
each is plain Python, its parts inlined verbatim and marked with the file they came from.

1. **The lorebook on the server.** Open WebUI reads the lorebook from the server's own filesystem. In a container,
   mount the folders into it first; see [In a container](#in-a-container).
2. **The filter**: Admin Panel → Functions → **Import from URL**, and give it
   `https://github.com/Technologicat/grimoire/blob/main/open-webui/grimoire_filter.py`. Save it, then switch it
   on with its **Active** toggle, make it apply to every model with its **Global** toggle, and set its valves
   (the gear icon).
3. **The tool**: Workspace → Tools → **Import from URL**, and give it
   `https://github.com/Technologicat/grimoire/blob/main/open-webui/grimoire_tool.py`. Save it, and set its valves.
   - **Give the users access to it**, from its **⋯** menu → **Access**: a tool a user cannot access is skipped
     for them without a word.
   - **Enable it for the models** that should have it, under Workspace → Models → (the model) → Tools.
4. **Check it works**: in a new chat with one of those models, mention a term from your lorebook, and ask about
   it. To exercise the tool, ask the model to look up a term in the lorebook that your message does not mention.

The valves, the same in both:

- **`lorebook_dir`**: the lorebook folder, as the Open WebUI server sees it. Empty turns grimoire off.
- **`ledger_dir`**: where the terms' inflected forms are read from, written by Raven or by `grimoire-expand`.
  Empty means Raven's folder, `~/.config/raven/librarian/lorebook_expansion`, in the server's home.
- **`stem_languages`**: comma-separated, such as `Finnish, Estonian`, for languages that inflect too much to list
  every form. Empty means whole-word forms only.

And in the filter only, **`budget`**, the most characters of definitions given with one message, 8,000 by default.

**For terms to match however they are inflected**, generate their inflected forms once, with Raven or with
grimoire's `grimoire-expand` ([grimoire's README](../README.md#inflected-forms)), and point `ledger_dir` at them.

### In a container

The folders must be mounted into the container, read-only will do, and the valves set to where they are mounted:
`-v ~/lorebook:/lorebook:ro`, and `lorebook_dir` = `/lorebook`. Three things to know:

- **A lorebook folder holding symlinks needs their targets mounted as well**, at the same paths, since a link to a
  host path resolves to nothing inside the container otherwise. A folder of links to glossaries living elsewhere
  is a natural way to keep a lorebook, and is why one lorebook can take two mounts.
- **The inflected forms are a mount of their own**, `-v ~/.config/raven/librarian/lorebook_expansion:/lorebook_expansion:ro`,
  with `ledger_dir` = `/lorebook_expansion`.
- **A mount takes effect when the container is started**, so a running one needs restarting.

[m97](https://github.com/Technologicat/m97), a dashboard and control panel for a gufo server, which starts Open
WebUI too, takes the mounts as a setting, `[openwebui] mounts`.

### Updating and removing

- **Update** by opening the plugin in its editor, replacing its code with the current file's, and saving. Open
  WebUI keeps the earlier code in the plugin's version history, and keeps its valves, checking them against the
  new code.
- **Remove** from the same list, Admin Panel → Functions or Workspace → Tools.

## What it does

**Before each call to the model, the definitions of the terms in your message and the four messages before it are
added**, as answers to `lorebook_lookup` calls the model did not make, just before your message, with the entries
their definitions link to, up to two links deep.

- **They are not stored in the chat.** Open WebUI rebuilds the conversation from the database at every turn, so
  the definitions are given afresh each time, for the terms in those five messages.
- **Inflected forms** match only if the inflected forms folder has them: generate them with Raven, or with
  `grimoire-expand` (see grimoire's README). Without them, a term matches only as written in the lorebook.
- **The folder is read again at every message**, so an edited definition is used at once.

## Limitations

- **A term mentioned only earlier than the last five messages is no longer defined**, unless it comes up again,
  or the model looks it up.
- **At most `budget` characters of definitions per message.** Past that, the remaining ones are not given.

## Building

The two files are generated by `scripts/build_open_webui.py` from grimoire's sources, with the core and the ledger
reader inlined, since Open WebUI keeps each plugin as one file. Edit the sources in `open-webui/src/`, then build.
