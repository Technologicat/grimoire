"""grimoire's Open WebUI tool: `lorebook_lookup`, for a term whose definition was not given."""

__all__ = ["Tools"]

from grimoire import lorebookcore
from lorebook_settings import LorebookValves, read_lorebook


class Tools:
    class Valves(LorebookValves):
        pass

    def __init__(self):
        self.valves = self.Valves()

    async def lorebook_lookup(self, term: str) -> str:
        entries, expansions = read_lorebook(self.valves)
        if not entries:
            return "The lorebook folder is not set: set it in the grimoire tool's settings."
        return lorebookcore.answer(entries, term, expansions=expansions)

    # The model is shown the core's own description of the tool, read from `lorebookcore.tool_spec`; Open WebUI
    # builds the specification from the docstring, with `:param:` lines for the arguments.
    lorebook_lookup.__doc__ = "{description}\n\n:param term: {term}".format(
        description=lorebookcore.tool_spec()["function"]["description"],
        term=lorebookcore.tool_spec()["function"]["parameters"]["properties"]["term"]["description"])
