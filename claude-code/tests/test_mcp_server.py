"""Tests for the plugin's MCP server, run as Claude Code runs it: a process speaking JSON-RPC over stdio."""

import json
import os
import pathlib
import subprocess
import sys

import pytest

SERVER = pathlib.Path(__file__).parent.parent / "scripts" / "mcp_server.py"

LOREBOOK = "## Hydra tax\nClosing one item opens two.\n\n## Fup\nNot a typo.\n"


@pytest.fixture
def lorebook(tmp_path):
    folder = tmp_path / "lorebook"
    folder.mkdir()
    (folder / "glossary.md").write_text(LOREBOOK, encoding="utf-8")
    return folder

def converse(messages, *, lorebook_dir="", ledger_dir="/nonexistent"):
    """Send `messages` to a fresh server, one per line; returns its replies, parsed."""
    env = {**os.environ, "GRIMOIRE_LOREBOOK_DIR": str(lorebook_dir), "GRIMOIRE_LEDGER_DIR": str(ledger_dir),
           "GRIMOIRE_STEM_LANGUAGES": ""}
    lines = "".join((m if isinstance(m, str) else json.dumps(m)) + "\n" for m in messages)
    result = subprocess.run([sys.executable, str(SERVER)], input=lines, capture_output=True, text=True, env=env,
                            timeout=30)
    assert result.returncode == 0, result.stderr
    return [json.loads(line) for line in result.stdout.splitlines()]

def call(term, n=2):
    return {"jsonrpc": "2.0", "id": n, "method": "tools/call",
            "params": {"name": "lorebook_lookup", "arguments": {"term": term}}}

INITIALIZE = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
              "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t"}}}
INITIALIZED = {"jsonrpc": "2.0", "method": "notifications/initialized"}


class TestProtocol:
    def test_the_handshake_and_the_tool_list(self):
        replies = converse([INITIALIZE, INITIALIZED, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}])
        assert [reply["id"] for reply in replies] == [1, 2], "a notification got a reply"
        assert replies[0]["result"]["protocolVersion"] == "2025-06-18"
        assert "tools" in replies[0]["result"]["capabilities"]
        (tool,) = replies[1]["result"]["tools"]
        assert tool["name"] == "lorebook_lookup"
        assert tool["inputSchema"]["type"] == "object"
        assert "term" in tool["inputSchema"]["properties"]

    def test_unknown_methods_tools_and_lines_are_errors(self):
        replies = converse(["{not json", {"jsonrpc": "2.0", "id": 5, "method": "resources/list"},
                            {"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "other"}}])
        assert [reply["error"]["code"] for reply in replies] == [-32700, -32601, -32602]


class TestLookup:
    def test_a_defined_term_is_answered_with_its_entry(self, lorebook):
        (reply,) = converse([call("hydra tax")], lorebook_dir=lorebook)
        assert reply["result"]["isError"] is False
        assert reply["result"]["content"] == [{"type": "text", "text": "Hydra tax\n\nClosing one item opens two."}]

    def test_an_undefined_term_is_answered_as_such(self, lorebook):
        (reply,) = converse([call("zorbitz")], lorebook_dir=lorebook)
        text = reply["result"]["content"][0]["text"]
        assert "zorbitz" in text and "Not a typo." not in text

    def test_the_folder_is_read_at_every_call(self, lorebook):
        # One server, the definition edited between two calls to it.
        env = {**os.environ, "GRIMOIRE_LOREBOOK_DIR": str(lorebook), "GRIMOIRE_LEDGER_DIR": "/nonexistent"}
        with subprocess.Popen([sys.executable, str(SERVER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              text=True, env=env) as server:
            def ask(n):
                server.stdin.write(json.dumps(call("fup", n)) + "\n")
                server.stdin.flush()
                return json.loads(server.stdout.readline())["result"]["content"][0]["text"]
            first = ask(2)
            (lorebook / "glossary.md").write_text(LOREBOOK.replace("Not a typo.", "Edited."), encoding="utf-8")
            second = ask(3)
            server.stdin.close()
        assert "Not a typo." in first
        assert "Edited." in second

    def test_an_unset_folder_is_said_so(self):
        # Claude Code passes a setting left empty as an empty string (observed 2026-11-23).
        (reply,) = converse([call("fup")], lorebook_dir="")
        assert "not set" in reply["result"]["content"][0]["text"]
