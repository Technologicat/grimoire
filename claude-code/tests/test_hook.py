"""Tests for the plugin's hooks, run as Claude Code runs them: a process, the event on stdin, the settings in
the environment."""

import json
import os
import pathlib
import subprocess
import sys

import pytest

HOOK = pathlib.Path(__file__).parent.parent / "scripts" / "hook.py"

LOREBOOK = """\
## Hydra tax
Closing one item opens two. Paid as [attention rent](#attention-rent).

## Attention rent
What an open item costs.

## Fup
Not a typo.
"""


@pytest.fixture
def plugin(tmp_path):
    """Runs a hook: `plugin(which, prompt=..., session=..., **options)` -> (the output's JSON or None, stderr)."""
    lorebook = tmp_path / "lorebook"
    lorebook.mkdir()
    (lorebook / "glossary.md").write_text(LOREBOOK, encoding="utf-8")
    data = tmp_path / "data"

    def run(which, *, prompt="", session="s1", **options):
        env = {key: value for key, value in os.environ.items() if not key.startswith("CLAUDE_PLUGIN_")}
        env["CLAUDE_PLUGIN_DATA"] = str(data)
        env["CLAUDE_PLUGIN_OPTION_LOREBOOK_DIR"] = str(lorebook)
        env["CLAUDE_PLUGIN_OPTION_LEDGER_DIR"] = str(tmp_path / "no-ledgers")
        env.update({f"CLAUDE_PLUGIN_OPTION_{key.upper()}": str(value) for key, value in options.items()})
        event = {"session_id": session, "prompt": prompt, "hook_event_name": "UserPromptSubmit"}
        result = subprocess.run([sys.executable, str(HOOK), which], input=json.dumps(event),
                                capture_output=True, text=True, env=env)
        assert result.returncode == 0, f"a hook must never stop the prompt: {result.stderr}"
        return (json.loads(result.stdout) if result.stdout.strip() else None), result.stderr

    run.lorebook = lorebook
    run.data = data
    return run

def context(output):
    assert output["hookSpecificOutput"]["hookEventName"] == "UserPromptSubmit"
    return output["hookSpecificOutput"]["additionalContext"]


class TestPrompt:
    def test_a_term_in_the_prompt_is_defined_with_what_it_links_to(self, plugin):
        output, _ = plugin("prompt", prompt="Is this a hydra tax?")
        text = context(output)
        assert "Closing one item opens two." in text
        assert "What an open item costs." in text
        assert "Not a typo." not in text

    def test_a_prompt_without_terms_gives_nothing(self, plugin):
        assert plugin("prompt", prompt="Nothing to see here.")[0] is None

    def test_an_entry_is_given_once_per_session(self, plugin):
        assert plugin("prompt", prompt="A hydra tax.")[0] is not None, \
            "nothing was given the first time, so this fixture cannot show it is not given again"
        assert plugin("prompt", prompt="Another hydra tax.")[0] is None
        assert plugin("prompt", prompt="A hydra tax.", session="s2")[0] is not None, "the record is per session"

    def test_after_compaction_it_is_given_again(self, plugin):
        plugin("prompt", prompt="A hydra tax.")
        assert plugin("prompt", prompt="A hydra tax.")[0] is None
        plugin("compact")
        assert plugin("prompt", prompt="A hydra tax.")[0] is not None

    def test_the_session_budget_runs_out(self, plugin):
        # Each of these entries costs 4,000 characters or so, so a session's 64,000 hold fifteen.
        (plugin.lorebook / "big.md").write_text(
            "".join(f"## Term{n}\n{'x' * 4_000}\n\n" for n in range(20)), encoding="utf-8")
        given = [plugin("prompt", prompt=f"term{n}")[0] is not None for n in range(20)]
        assert given[:15] == [True] * 15
        assert given[15:] == [False] * 5

    def test_an_edited_definition_is_given_again_with_a_note(self, plugin):
        first = context(plugin("prompt", prompt="A hydra tax.")[0])
        assert "Changed on disk" not in first
        assert plugin("prompt", prompt="A hydra tax.")[0] is None, \
            "an unchanged entry was given again, so this fixture cannot tell an edit from a repeat"
        glossary = plugin.lorebook / "glossary.md"
        glossary.write_text(glossary.read_text(encoding="utf-8").replace("opens two", "opens three"), encoding="utf-8")
        again = context(plugin("prompt", prompt="A hydra tax.")[0])
        assert "Changed on disk" in again and "opens three" in again
        assert "What an open item costs." not in again, "the unchanged entry it links to was given again"
        assert plugin("prompt", prompt="A hydra tax.")[0] is None, "the edited entry is given once more, then not"

    def test_a_record_listing_ids_alone_reads_as_given_and_unchanged(self, plugin):
        sessions = plugin.data / "sessions"
        sessions.mkdir(parents=True)
        (sessions / "s1.json").write_text(json.dumps({"given": ["hydra-tax", "attention-rent"], "spent": 100}), encoding="utf-8")
        assert plugin("prompt", prompt="A hydra tax.")[0] is None

    def test_one_prompts_definitions_stay_under_the_hook_output_cap(self, plugin):
        (plugin.lorebook / "many.md").write_text("".join(f"## T{n}\nx\n\n" for n in range(2_000)), encoding="utf-8")
        text = context(plugin("prompt", prompt=" ".join(f"t{n}" for n in range(2_000)))[0])
        assert text.count("---") > 100, "few entries fired, so this fixture does not test the separators' share"
        assert len(text) < 10_000

    def test_an_inflected_term_fires_by_the_ledger(self, plugin, tmp_path):
        sys.path.insert(0, str(HOOK.parent))
        try:
            import ledger
        finally:
            sys.path.remove(str(HOOK.parent))
        assert plugin("prompt", prompt="Two hydra taxes.")[0] is None, \
            "the term fires without its forms, so this fixture cannot tell whether the ledger was read"
        ledgers = tmp_path / "ledgers"
        ledgers.mkdir()
        line = {"id": "Hydra tax", "v": "0123abcd", "status": "ok", "d": ledger.digest(ledger.render("Hydra tax", "tax")),
                "answer": {"tax": {"English": {"forms": ["taxes"], "stems": []}}}}
        (ledgers / "expansions-0123abcd.jsonl").write_text(json.dumps(line) + "\n", encoding="utf-8")
        assert plugin("prompt", prompt="Two hydra taxes.", ledger_dir=ledgers)[0] is not None


class TestNeverStopsThePrompt:
    def test_without_a_lorebook_setting_it_does_nothing(self, plugin):
        output, stderr = plugin("prompt", prompt="A hydra tax.", lorebook_dir="")
        assert output is None and stderr == ""

    def test_a_missing_lorebook_folder_gives_nothing(self, plugin, tmp_path):
        assert plugin("prompt", prompt="A hydra tax.", lorebook_dir=tmp_path / "nowhere")[0] is None

    def test_a_bad_event_is_reported_and_the_prompt_goes_ahead(self, plugin):
        result = subprocess.run([sys.executable, str(HOOK), "prompt"], input="not json", capture_output=True,
                                text=True, env={**os.environ, "CLAUDE_PLUGIN_OPTION_LOREBOOK_DIR": str(plugin.lorebook),
                                                "CLAUDE_PLUGIN_DATA": str(plugin.data)})
        assert result.returncode == 0
        assert result.stdout == ""
        assert "grimoire: JSONDecodeError" in result.stderr
