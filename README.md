# grimoire

The lorebook of [Raven](https://github.com/Technologicat/raven), for other LLM frontends.

A lorebook gives an LLM the definitions of your own terms when a term comes up in the conversation: your
coinages, a field's jargon, the special sense you give an ordinary word. The definitions live in a folder of
Markdown files, each entry a section whose header is the term. Raven-librarian reads such a folder; grimoire
lets Claude Code, Open WebUI, pi and LM Studio read the same one.

**Status: early.** Raven's core is synced here and tested; no port is usable yet. [`briefs/ports-brief.md`](briefs/ports-brief.md) is the plan, and
Raven's [porting guide](https://github.com/Technologicat/raven/blob/main/raven/librarian/lorebook-porting.md)
describes what each port has to do.

## License

[BSD 2-Clause](LICENSE.md).
