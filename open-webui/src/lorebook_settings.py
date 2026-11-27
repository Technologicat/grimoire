"""What grimoire's Open WebUI filter and tool share: their settings, and the lorebook those settings name."""

__all__ = ["grimoire_log", "LorebookValves", "read_lorebook"]

import logging

from pydantic import BaseModel, Field

from grimoire import ledger, lorebookcore

grimoire_log = logging.getLogger("grimoire")


class LorebookValves(BaseModel):
    """The settings the filter and the tool both have. Folders are as the Open WebUI server sees them, which in a
    container means where they are mounted."""
    lorebook_dir: str = Field(default="", description="The lorebook folder: Markdown files, each entry a section "
                                                      "whose header is the term. Empty turns grimoire off.")
    ledger_dir: str = Field(default="", description="Where the terms' inflected forms are read from: Raven's "
                                                    "expansion ledgers, or grimoire-expand's. Empty for Raven's "
                                                    "own folder, ~/.config/raven/librarian/lorebook_expansion.")
    stem_languages: str = Field(default="", description="Comma-separated, such as \"Finnish, Estonian\": languages "
                                                        "whose stems are used as well as their whole-word forms.")


def read_lorebook(valves: LorebookValves) -> tuple[dict, dict]:
    """`(entries, expansions)` for the folders `valves` names; both empty when no lorebook folder is set.

    Read afresh at every call, so an edited definition is used at once.
    """
    if not valves.lorebook_dir.strip():
        return {}, {}
    entries, problems = lorebookcore.load(valves.lorebook_dir.strip())
    for filename, problem in problems.items():
        grimoire_log.warning(f"grimoire: {filename}: {problem}")
    languages = {language.strip() for language in valves.stem_languages.split(",") if language.strip()}
    expansions = ledger.load_expansions(valves.ledger_dir.strip() or ledger.DEFAULT_DIRECTORY, entries,
                                        stem_languages=languages)
    return entries, expansions
