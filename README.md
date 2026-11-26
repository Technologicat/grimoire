# grimoire

The lorebook of [Raven](https://github.com/Technologicat/raven), for other LLM frontends.

A lorebook gives an LLM the definitions of your own terms when a term comes up in the conversation: your
coinages, a field's jargon, the special sense you give an ordinary word. The definitions live in a folder of
Markdown files, each entry a section whose header is the term. Raven-librarian reads such a folder; grimoire
lets Claude Code, Open WebUI, pi and LM Studio read the same one.

**Status: early.** The Claude Code, Open WebUI and pi ports work; LM Studio is still to come.

## Claude Code

A plugin. In Claude Code:

```
/plugin marketplace add Technologicat/grimoire
/plugin install grimoire@grimoire
```

Its settings, updating, what it does and its limitations: [`claude-code/README.md`](claude-code/README.md).

## Open WebUI

A filter function, which gives the definitions, and a tool, which lets the model look a term up, each imported
from its URL by an admin. Installing them, their settings, a lorebook in a container, and what they do:
[`open-webui/README.md`](open-webui/README.md).

## pi

An extension. In a shell:

```
pi install git:github.com/Technologicat/grimoire
```

Its settings, what it does and its limitations: [`pi/README.md`](pi/README.md).

## Inflected forms

**A term matches however it is inflected only if its inflected forms have been generated**: "hydra taxes" for
*hydra tax*, and in a language like Finnish nearly every use of a word. Raven generates them; on a machine without
Raven, grimoire's generator does the same, asking any OpenAI-compatible LLM server:

```
pipx install git+https://github.com/Technologicat/grimoire
grimoire-expand --lorebook ~/lorebook --url http://localhost:8080
grimoire-expand --lorebook ~/lorebook --url http://localhost:8080 --language English=forms --language Finnish=stems
```

`--language` is repeatable; `stems` also asks for the beginnings of words that their endings attach to, for
languages that inflect too much to list every form. The default is English, whole-word forms only.

- **The forms go to Raven's folder**, `~/.config/raven/librarian/lorebook_expansion`, in Raven's format, where
  grimoire's ports and Raven both read them.
- **A run asks only the terms without forms yet**, so an interrupted run is resumed by running it again, and
  after editing the lorebook, a run asks only the edited terms.
- **The forms belong to one model**: a run with another model asks every term again, into a file of its own.

## Plans

[`briefs/ports-brief.md`](briefs/ports-brief.md) is the plan, and
Raven's [porting guide](https://github.com/Technologicat/raven/blob/main/raven/librarian/lorebook-porting.md)
describes what each port has to do.

## License

[BSD 2-Clause](LICENSE.md).
