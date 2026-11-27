"""Tests for grimoire's Open WebUI filter and tool, run against the generated files, which are what is installed."""

import asyncio
import copy
import importlib.util
import pathlib
import subprocess
import sys
import sysconfig

import pytest

HERE = pathlib.Path(__file__).parent.parent
GLOSSARY = """\
## Hydra tax
Closing one item opens two. Paid as [attention rent](#attention-rent).

## Attention rent
What an open item costs.

## Fup
Not a typo.
"""


def load(name):
    spec = importlib.util.spec_from_file_location(f"generated_{name}", HERE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

@pytest.fixture(scope="module")
def generated():
    return load("grimoire_filter"), load("grimoire_tool")

@pytest.fixture
def lorebook(tmp_path):
    (tmp_path / "glossary.md").write_text(GLOSSARY, encoding="utf-8")
    return tmp_path

@pytest.fixture
def the_filter(generated, lorebook, tmp_path):
    the_filter = generated[0].Filter()
    the_filter.valves.lorebook_dir = str(lorebook)
    the_filter.valves.ledger_dir = str(tmp_path / "no-ledgers")
    return the_filter

def request(the_filter, messages):
    return asyncio.run(the_filter.request({"model": "m", "messages": copy.deepcopy(messages)}))["messages"]

def given(messages):
    """The titles of the definitions inserted, from the round's calls."""
    return [call["function"]["arguments"] for message in messages for call in message.get("tool_calls") or ()
            if call["id"].startswith("grimoire-lorebook-")]

USER = {"role": "user", "content": "Is this a hydra tax?"}


class TestGenerated:
    def test_each_file_runs_without_grimoire_on_the_path(self):
        # `-S` skips site-packages and the `.pth` files in it, the dev venv's editable install among them, which
        # would put the grimoire package on the path; site-packages itself is then added back, for pydantic.
        script = ("import importlib.util, sys\n"
                  f"sys.path.append({sysconfig.get_paths()['purelib']!r})\n"
                  "for module in ('grimoire', 'ledger', 'lorebookcore'):\n"
                  "    try:\n        __import__(module)\n    except ImportError:\n        pass\n"
                  "    else:\n        raise SystemExit(f'{module} is importable, so this check cannot tell whether it was inlined')\n"
                  "for name in ('grimoire_filter', 'grimoire_tool'):\n"
                  f"    spec = importlib.util.spec_from_file_location(name, {str(HERE)!r} + f'/{{name}}.py')\n"
                  "    spec.loader.exec_module(importlib.util.module_from_spec(spec))\n"
                  "print('ok')\n")
        result = subprocess.run([sys.executable, "-I", "-S", "-c", script], capture_output=True, text=True, cwd="/")
        assert result.stdout.strip() == "ok", result.stdout + result.stderr

    def test_the_files_are_current(self):
        result = subprocess.run([sys.executable, str(HERE.parent / "scripts" / "build_open_webui.py"), "--check"],
                                capture_output=True, text=True)
        assert result.returncode == 0, result.stdout + result.stderr


class TestFilter:
    def test_the_definitions_go_before_the_users_message_as_a_tool_round(self, the_filter):
        system = {"role": "system", "content": "Be brief."}
        out = request(the_filter, [system, USER])
        assert out[0] == system and out[-1] == USER
        call, *answers = out[1:-1]
        assert call["role"] == "assistant" and len(call["tool_calls"]) == len(answers) == 2
        assert [answer["tool_call_id"] for answer in answers] == [c["id"] for c in call["tool_calls"]]
        assert answers[0]["content"] == "Hydra tax\n\nClosing one item opens two. Paid as [attention rent](#attention-rent)."
        assert answers[1]["content"] == "Attention rent\n\nWhat an open item costs."

    def test_running_again_changes_nothing(self, the_filter):
        once = request(the_filter, [USER])
        assert len(once) > 1, "nothing was inserted, so this fixture cannot show a second run adds nothing"
        assert request(the_filter, once) == once

    def test_a_tool_loop_hop_keeps_the_round_where_it_is(self, the_filter):
        # The model's own lookup after the user's message, as on the second call of a tool loop.
        own_call = {"role": "assistant", "content": "", "tool_calls": [
            {"id": "call_1", "type": "function", "function": {"name": "lorebook_lookup", "arguments": "{}"}}]}
        own_answer = {"role": "tool", "tool_call_id": "call_1", "content": "Fup\n\nNot a typo."}
        first = request(the_filter, [USER])
        hop = request(the_filter, first + [own_call, own_answer])
        assert hop == first + [own_call, own_answer]

    def test_the_scan_reaches_the_four_messages_before(self, the_filter):
        reply = {"role": "assistant", "content": "Paying the fup again."}
        filler = [{"role": "user", "content": "And?"}, {"role": "assistant", "content": "So."}]
        # Fourth before the user's message, so the last of the five scanned; then fifth, and out.
        assert '{"term": "Fup"}' in given(request(the_filter, [reply, *filler, filler[0], USER]))
        assert '{"term": "Fup"}' not in given(request(the_filter, [reply, *filler, *filler, USER]))

    def test_system_and_tool_messages_fire_nothing(self, the_filter):
        quiet = {"role": "user", "content": "Hello."}
        assert request(the_filter, [{"role": "system", "content": "Mind the hydra tax."}, quiet])[0]["role"] == "system"
        assert given(request(the_filter, [{"role": "system", "content": "Mind the hydra tax."}, quiet])) == []
        assert given(request(the_filter, [{"role": "tool", "tool_call_id": "x", "content": "hydra tax"}, quiet])) == []

    def test_content_given_as_parts_is_read(self, the_filter):
        parts = {"role": "user", "content": [{"type": "text", "text": "A hydra tax?"},
                                             {"type": "image_url", "image_url": {"url": "data:,"}}]}
        assert given(request(the_filter, [parts]))

    def test_the_budget_holds(self, the_filter):
        the_filter.valves.budget = 100  # the hydra tax's entry, 81 characters, fits; the one it links to, 40, not
        assert [g for g in given(request(the_filter, [USER]))] == ['{"term": "Hydra tax"}']

    def test_an_inflected_term_fires_by_the_ledger(self, the_filter, tmp_path, generated):
        ledger_module = generated[0].ledger
        assert not given(request(the_filter, [{"role": "user", "content": "Two hydra taxes."}])), \
            "the term fires without its forms, so this fixture cannot tell whether the ledger was read"
        import json
        line = {"id": "Hydra tax", "v": "0123abcd", "status": "ok",
                "d": ledger_module.digest(ledger_module.render("Hydra tax", "tax")),
                "answer": {"tax": {"English": {"forms": ["taxes"], "stems": []}}}}
        (tmp_path / "ledgers").mkdir()
        (tmp_path / "ledgers" / "expansions-0123abcd.jsonl").write_text(json.dumps(line) + "\n", encoding="utf-8")
        the_filter.valves.ledger_dir = str(tmp_path / "ledgers")
        assert given(request(the_filter, [{"role": "user", "content": "Two hydra taxes."}]))


class TestNeverStopsTheMessage:
    def test_without_a_lorebook_folder_nothing_changes(self, the_filter):
        the_filter.valves.lorebook_dir = ""
        assert request(the_filter, [USER]) == [USER]

    def test_a_missing_folder_changes_nothing(self, the_filter, tmp_path):
        the_filter.valves.lorebook_dir = str(tmp_path / "nowhere")
        assert request(the_filter, [USER]) == [USER]

    def test_a_malformed_body_is_returned_as_it_came(self, the_filter):
        body = {"model": "m", "messages": "not a list"}
        assert asyncio.run(the_filter.request(body)) == {"model": "m", "messages": "not a list"}


class TestTool:
    @pytest.fixture
    def tools(self, generated, lorebook, tmp_path):
        tools = generated[1].Tools()
        tools.valves.lorebook_dir = str(lorebook)
        tools.valves.ledger_dir = str(tmp_path / "no-ledgers")
        return tools

    def test_a_term_is_answered_with_its_entry(self, tools):
        assert asyncio.run(tools.lorebook_lookup("fup")) == "Fup\n\nNot a typo."

    def test_an_unset_folder_is_said_so(self, tools):
        tools.valves.lorebook_dir = ""
        assert "not set" in asyncio.run(tools.lorebook_lookup("fup"))

    def test_the_model_is_shown_the_cores_description(self, generated):
        # Open WebUI takes the description from the docstring's lines before the first `:param`, and each
        # argument's from its `:param name:` line.
        core = generated[1].lorebookcore
        spec = core.tool_spec()["function"]
        description, _, params = generated[1].Tools.lorebook_lookup.__doc__.partition(":param")
        assert description.strip() == spec["description"]
        assert params.strip() == f"term: {spec['parameters']['properties']['term']['description']}"
