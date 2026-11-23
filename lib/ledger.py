"""The lorebook's inflected forms, read from Raven's sweep ledgers.

Raven asks an LLM for each term's inflected forms and keeps the answers in ledgers, JSONL files in one folder,
one per model and prompt. The format is Raven's `sweep-ledger.md`, and what the lorebook's answers hold is in
its `lorebook-porting.md`, under "The forms Raven generated":
https://github.com/Technologicat/raven/tree/main/raven/librarian

    expansions = load_expansions(DEFAULT_DIRECTORY, entries)
    lorebookcore.find_matches(entries, text, expansions=expansions)

Standard library only, beside a copy of `lorebookcore`.
"""

__all__ = ["DEFAULT_DIRECTORY", "LEDGER_NAME",
           "render", "digest",
           "latest", "answers",
           "expansions_from", "load_expansions"]

import hashlib
import json
import pathlib
from collections.abc import Collection, Mapping
from typing import Any

import lorebookcore

DEFAULT_DIRECTORY = pathlib.Path.home() / ".config" / "raven" / "librarian" / "lorebook_expansion"
LEDGER_NAME = "expansions"


def render(term: str, word: str) -> str:
    """A term as the prompt shows it, asking for the forms of `word`, the term's last word."""
    return f"{term} — inflect: {word}"

def digest(text: str) -> str:
    """The digest a ledger keeps of an item as it was asked: sixteen hex digits of its SHA-256."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def latest(path: str | pathlib.Path) -> dict[str, dict]:
    """The latest line for each item in one ledger, answered or failed, keyed by id.

    `path`: an answers file, `{name}-{fingerprint}.jsonl`. Only lines carrying that fingerprint count, so a line
            copied in from another ledger is ignored. A line that does not parse is skipped.
    """
    path = pathlib.Path(path)
    fingerprint = path.stem.rpartition("-")[2]
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:  # a run killed mid-write leaves one
            continue
        if isinstance(entry, dict) and entry.get("v") == fingerprint and isinstance(entry.get("id"), str):
            out[entry["id"]] = entry
    return out

def answers(directory: str | pathlib.Path, terms: Mapping[str, tuple[str, ...]]) -> dict[str, Any]:
    """The current answer for each term, from every expansions ledger in `directory`.

    `terms`: as `lorebookcore.terms` gives them, term -> its words.

    An answer is current if it is the latest line for its term in its ledger, answered rather than failed, and
    was given about the term as it is now, its digest matching. Where several ledgers have one, the most recently
    modified ledger's wins. A term with no current answer is left out; a missing directory has none.
    """
    directory = pathlib.Path(directory).expanduser()
    if not directory.is_dir():
        return {}
    # The traces file shares the prefix, so it is told apart by the fingerprint, which is all hex.
    ledgers = [path for path in directory.glob(f"{LEDGER_NAME}-*.jsonl")
               if _is_fingerprint(path.stem.removeprefix(f"{LEDGER_NAME}-"))]
    digests = {term: digest(render(term, words[-1])) for term, words in terms.items() if words}
    out = {}
    for path in sorted(ledgers, key=lambda path: path.stat().st_mtime):  # oldest first, so the newest wins
        for term, entry in latest(path).items():
            if (term in digests and entry.get("status") == "ok" and entry.get("d") == digests[term] and
                    isinstance(entry.get("answer"), dict)):
                out[term] = entry["answer"]
    return out

def _is_fingerprint(text: str) -> bool:
    return len(text) == 8 and all(c in "0123456789abcdef" for c in text)


def expansions_from(answers: Mapping[str, Any],
                    *,
                    stem_languages: Collection[str] = ()) -> dict[str, lorebookcore.Expansion]:
    """Expansions, by key word, from answers as `answers` gives them: each word's forms and stems, cleaned.

    `answers`: term -> word -> language -> `{"forms": [...], "stems": [...]}`.
    `stem_languages`: the languages whose stems are used. Forms are used from every language.

    A word in several terms gets what all of them gave it. A word left with neither forms nor stems is left out.
    """
    forms: dict[str, list[str]] = {}
    stems: dict[str, list[str]] = {}
    for answer in answers.values():
        for word, by_language in answer.items():
            if not isinstance(by_language, dict):
                continue
            for language, given in by_language.items():
                if not isinstance(given, dict):
                    continue
                forms.setdefault(word, []).extend(_strings(given.get("forms")))
                if language in stem_languages:
                    stems.setdefault(word, []).extend(_strings(given.get("stems")))
    expansions = {word: lorebookcore.clean_expansion(word, forms[word], stems.get(word, ())) for word in forms}
    return {word: expansion for word, expansion in expansions.items() if expansion.forms or expansion.stems}

def _strings(value: Any) -> list[str]:
    """The strings in `value`, if it is a list; anything else a model's answer put there is left out."""
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def load_expansions(directory: str | pathlib.Path,
                    entries: Mapping[str, lorebookcore.Entry],
                    *,
                    stem_languages: Collection[str] = ()) -> dict[str, lorebookcore.Expansion]:
    """The expansions for `entries`, from the ledgers in `directory`: `answers`, then `expansions_from`."""
    return expansions_from(answers(directory, lorebookcore.terms(entries)), stem_languages=stem_languages)
