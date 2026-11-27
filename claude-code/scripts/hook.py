"""grimoire's Claude Code hooks: definitions from the lorebook as their terms come up.

    python3 hook.py prompt     # UserPromptSubmit: the definitions for the terms in the prompt
    python3 hook.py compact    # SessionStart, after compaction: forget what this session was given

Claude Code gives the hook its event as JSON on stdin, and the plugin's settings as `CLAUDE_PLUGIN_OPTION_*`.
What each session was given is kept in `${CLAUDE_PLUGIN_DATA}/sessions/`, so that each entry is given once.

A hook never stops the prompt: whatever goes wrong is reported on stderr, and the prompt goes ahead without
definitions.
"""

import sys

if sys.version_info < (3, 11):  # before the imports, which need 3.11
    print(f"grimoire: needs Python 3.11 or later, but `python3` is {sys.version.split()[0]}", file=sys.stderr)
    sys.exit(0)

import hashlib
import json
import os
import pathlib
import re
import time

import ledger
import lorebookcore

# Characters rather than tokens, as the conformance cases count them. A hook's output is capped at 10,000
# characters, beyond which Claude Code passes on only a file path and a preview, so one prompt's definitions
# stay under that with room for the heading.
PROMPT_BUDGET = 8_000
SESSION_BUDGET = 64_000
MAX_DEPTH = 2
SESSION_RECORD_DAYS = 30  # a session's record left untouched this long is removed

HEADING = "Definitions from the user's lorebook, for terms in their message:"
SEPARATOR = "\n\n---\n\n"
# Before a definition edited since this session was given it, so that the model knows why it comes again.
CHANGED_NOTE = "(Changed on disk since it was given earlier in this conversation.)\n\n"


def option(key: str) -> str:
    """A plugin setting, stripped; empty if unset."""
    return os.environ.get(f"CLAUDE_PLUGIN_OPTION_{key.upper()}", "").strip()


# --------------------------------------------------------------------------------
# What a session was given

def _sessions_dir() -> pathlib.Path:
    return pathlib.Path(os.environ["CLAUDE_PLUGIN_DATA"]) / "sessions"

def _record_path(session_id: str) -> pathlib.Path:
    # The id becomes a filename, so anything that is not plainly safe in one is replaced.
    return _sessions_dir() / f"{re.sub(r'[^A-Za-z0-9_-]', '_', session_id)}.json"

def digest(entry: lorebookcore.Entry) -> str:
    """What says an entry is the one that was given: sixteen hex digits of the SHA-256 of its text as given."""
    return hashlib.sha256(lorebookcore.format_entry(entry).encode("utf-8")).hexdigest()[:16]

def read_record(session_id: str) -> dict:
    """What this session was given: `{"given": {entry id: digest of the text given}, "spent": characters}`.

    A record that lists the ids alone, as an earlier version wrote, reads as given with no digest: `None`.
    """
    try:
        record = json.loads(_record_path(session_id).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"given": {}, "spent": 0}
    given = record.get("given", {})
    if isinstance(given, list):
        given = dict.fromkeys(given)
    return {"given": dict(given), "spent": int(record.get("spent", 0))}

def write_record(session_id: str, record: dict) -> None:
    path = _record_path(session_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(record), encoding="utf-8")
    temporary.replace(path)  # atomic, so a hook killed mid-write leaves the old record

def forget(session_id: str) -> None:
    _record_path(session_id).unlink(missing_ok=True)

def prune_records() -> None:
    """Remove the records of sessions not touched in `SESSION_RECORD_DAYS`."""
    cutoff = time.time() - SESSION_RECORD_DAYS * 24 * 3600
    for path in _sessions_dir().glob("*.json"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
        except OSError:  # another session's hook got there first
            pass


# --------------------------------------------------------------------------------
# The hooks

def on_prompt(event: dict) -> dict | None:
    """The `UserPromptSubmit` output giving the definitions for the prompt's terms, or `None` if there are none."""
    maybe_lorebook = option("lorebook_dir")
    if not maybe_lorebook:
        return None
    entries, problems = lorebookcore.load(maybe_lorebook)
    for filename, problem in problems.items():
        print(f"grimoire: {filename}: {problem}", file=sys.stderr)
    if not entries:
        return None

    session_id = event["session_id"]
    record = read_record(session_id)
    budget = min(PROMPT_BUDGET, SESSION_BUDGET - record["spent"])
    if budget <= 0:
        return None
    expansions = ledger.load_expansions(option("ledger_dir") or ledger.DEFAULT_DIRECTORY, entries,
                                        stem_languages=_languages(option("stem_languages")))
    # Given and unchanged: the digest matches, or there is none to compare. Given but edited since: may fire
    # again, with a note.
    unchanged = {entry_id for entry_id, given in record["given"].items()
                 if entry_id in entries and given in (None, digest(entries[entry_id]))}
    changed = {entry_id for entry_id in record["given"] if entry_id in entries and entry_id not in unchanged}
    changed_texts = {lorebookcore.format_entry(entries[entry_id]) for entry_id in changed}

    # Each entry is counted with the separator before it, and the note where it gets one, so the definitions
    # stay within the budget however many there are.
    def size(text: str) -> int:
        return len(text) + len(SEPARATOR) + (len(CHANGED_NOTE) if text in changed_texts else 0)
    firings = lorebookcore.select(entries, event.get("prompt", ""), count_tokens=size,
                                  budget=budget, max_depth=MAX_DEPTH, already_fired=unchanged,
                                  expansions=expansions)
    if not firings:
        return None

    write_record(session_id, {"given": record["given"] | {firing.entry.id: digest(firing.entry) for firing in firings},
                              "spent": record["spent"] + sum(firing.tokens for firing in firings)})
    context = HEADING + "".join(SEPARATOR + (CHANGED_NOTE if firing.entry.id in changed else "") +
                                lorebookcore.format_entry(firing.entry) for firing in firings)
    return {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": context}}

def _languages(setting: str) -> set[str]:
    """Languages written as a comma-separated list: `"Finnish, Estonian"`."""
    return {language.strip() for language in setting.split(",") if language.strip()}

def on_compact(event: dict) -> None:
    """Forget what the session was given: compaction summarizes the definitions away, so they are given again
    as their terms come up again."""
    forget(event["session_id"])


def main() -> None:
    try:
        event = json.load(sys.stdin)
        which = sys.argv[1] if len(sys.argv) > 1 else ""
        if which == "prompt":
            maybe_output = on_prompt(event)
            if maybe_output is not None:
                print(json.dumps(maybe_output))
        elif which == "compact":
            on_compact(event)
        else:
            print(f"grimoire: unknown hook {which!r}", file=sys.stderr)
        prune_records()
    except Exception as exc:  # noqa: BLE001 -- the prompt goes ahead whatever happens here
        print(f"grimoire: {type(exc).__name__}: {exc}", file=sys.stderr)
    sys.exit(0)


if __name__ == "__main__":
    main()
