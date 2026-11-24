"""grimoire's Open WebUI filter: the definitions of the terms in the conversation, as the model is about to read it."""

__all__ = ["Filter"]

import json

from pydantic import Field

import lorebookcore
from lorebook_settings import LorebookValves, grimoire_log, read_lorebook

# Raven's scan and depth. Characters rather than tokens, as the conformance cases count them.
SCANNED_MESSAGES = 5  # the new message and the four before it
MAX_DEPTH = 2
CALL_ID_PREFIX = "grimoire-lorebook-"


def _text(message: dict) -> str:
    """A message's text, whether its content is a string or a list of parts."""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(part.get("text", "") for part in content
                         if isinstance(part, dict) and part.get("type") == "text")
    return ""

def definitions_round(entries: list[lorebookcore.Entry]) -> list[dict]:
    """The entries as a round of `lorebook_lookup` calls and their answers, as if the model had looked them up."""
    calls = [{"id": f"{CALL_ID_PREFIX}{n}", "type": "function",
              "function": {"name": lorebookcore.TOOL_NAME, "arguments": json.dumps({"term": entry.title})}}
             for n, entry in enumerate(entries)]
    answers = [{"role": "tool", "tool_call_id": call["id"], "content": lorebookcore.format_entry(entry)}
               for call, entry in zip(calls, entries)]
    return [{"role": "assistant", "content": "", "tool_calls": calls}, *answers]

def with_definitions(messages: list[dict], entries: dict, expansions: dict, *, budget: int) -> list[dict]:
    """`messages` with the definitions for the terms near its end inserted before its last user message.

    Scans the last user message and the user and assistant messages before it, `SCANNED_MESSAGES` in all; system
    and tool messages are left out, so neither a system prompt nor an earlier definition fires anything. Returns
    `messages` itself, unchanged, when there is nothing to give, or when its definitions are already there.
    """
    if any(call.get("id", "").startswith(CALL_ID_PREFIX)
           for message in messages for call in message.get("tool_calls") or ()):
        return messages  # this request already has them: `request` runs again on each hop of a tool loop
    maybe_last_user = next((i for i in range(len(messages) - 1, -1, -1) if messages[i].get("role") == "user"), None)
    if maybe_last_user is None:
        return messages
    conversation = [message for message in messages[:maybe_last_user + 1]
                    if message.get("role") in ("user", "assistant")]
    text = "\n\n".join(_text(message) for message in conversation[-SCANNED_MESSAGES:])
    firings = lorebookcore.select(entries, text, count_tokens=len, budget=budget, max_depth=MAX_DEPTH,
                                  expansions=expansions)
    if not firings:
        return messages
    return [*messages[:maybe_last_user], *definitions_round([firing.entry for firing in firings]),
            *messages[maybe_last_user:]]


class Filter:
    class Valves(LorebookValves):
        budget: int = Field(default=8_000, description="The most characters of definitions given with one message.")
        priority: int = Field(default=0, description="Where this filter runs among the others; lower runs first.")

    def __init__(self):
        self.valves = self.Valves()

    async def request(self, body: dict) -> dict:
        try:
            entries, expansions = read_lorebook(self.valves)
            if entries:
                body["messages"] = with_definitions(body.get("messages", []), entries, expansions,
                                                    budget=self.valves.budget)
        except Exception as exc:  # noqa: BLE001 -- the message goes ahead without definitions rather than failing
            grimoire_log.warning(f"grimoire: {type(exc).__name__}: {exc}")
        return body
