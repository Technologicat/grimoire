"""grimoire's MCP server: the lorebook lookup tool, for a term whose definition was not given.

    python3 mcp_server.py

Speaks MCP over stdio, one JSON-RPC message per line, and offers one tool, `lorebook_lookup`, answering as
`lorebookcore.answer` does. Settings come from the environment, as the plugin's `.mcp.json` passes them:
`GRIMOIRE_LOREBOOK_DIR`, `GRIMOIRE_LEDGER_DIR` and `GRIMOIRE_STEM_LANGUAGES`, as the hooks' settings of the
same names. The folder is read again at every call, so an edited definition is used at once.

Standard library only.
"""

import sys

if sys.version_info < (3, 11):  # before the imports, which need 3.11
    print(f"grimoire: needs Python 3.11 or later, but `python3` is {sys.version.split()[0]}", file=sys.stderr)
    sys.exit(1)

import json
import os
from typing import Any

import ledger
import lorebookcore

SERVER_INFO = {"name": "grimoire", "version": "0"}


# Claude Code exports the plugin's settings as `CLAUDE_PLUGIN_OPTION_*` to hooks only, so `.mcp.json` passes
# them to this server under names of its own.
def setting(name: str) -> str:
    """A setting from the environment, stripped; empty if unset."""
    return os.environ.get(f"GRIMOIRE_{name.upper()}", "").strip()


def tool() -> dict[str, Any]:
    """The lookup tool as MCP lists it, from the core's OpenAI-style specification."""
    function = lorebookcore.tool_spec()["function"]
    return {"name": function["name"], "description": function["description"], "inputSchema": function["parameters"]}

def look_up(arguments: dict) -> str:
    """The tool's answer for `arguments["term"]`."""
    maybe_lorebook = setting("lorebook_dir")
    if not maybe_lorebook:
        return "The lorebook folder is not set: set it in grimoire's plugin settings."
    entries, _ = lorebookcore.load(maybe_lorebook)
    languages = {language.strip() for language in setting("stem_languages").split(",") if language.strip()}
    expansions = ledger.load_expansions(setting("ledger_dir") or ledger.DEFAULT_DIRECTORY, entries,
                                        stem_languages=languages)
    return lorebookcore.answer(entries, str(arguments.get("term", "")), expansions=expansions)


def respond(message: dict) -> dict | None:
    """The response to one JSON-RPC message; `None` for a notification, which gets none."""
    method = message.get("method")
    if "id" not in message:  # a notification, such as `notifications/initialized`
        return None

    def result(value: dict) -> dict:
        return {"jsonrpc": "2.0", "id": message["id"], "result": value}

    def error(code: int, text: str) -> dict:
        return {"jsonrpc": "2.0", "id": message["id"], "error": {"code": code, "message": text}}

    params = message.get("params") or {}
    if method == "initialize":
        # One tool and nothing else, which every protocol version describes alike, so the client's own is taken.
        return result({"protocolVersion": params.get("protocolVersion", "2025-06-18"),
                       "capabilities": {"tools": {}}, "serverInfo": SERVER_INFO})
    if method == "ping":
        return result({})
    if method == "tools/list":
        return result({"tools": [tool()]})
    if method == "tools/call":
        if params.get("name") != lorebookcore.TOOL_NAME:
            return error(-32602, f"no such tool: {params.get('name')!r}")
        try:
            text, failed = look_up(params.get("arguments") or {}), False
        except Exception as exc:  # noqa: BLE001 -- reported to the model as a failed call, which it can act on
            text, failed = f"The lookup failed: {type(exc).__name__}: {exc}", True
        return result({"content": [{"type": "text", "text": text}], "isError": failed})
    return error(-32601, f"method not found: {method!r}")


def main() -> None:
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            reply = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}}
        else:
            reply = respond(message) if isinstance(message, dict) else None
        if reply is not None:
            print(json.dumps(reply), flush=True)


if __name__ == "__main__":
    main()
