"""Tests for `ledger`: reading the inflected forms out of Raven's sweep ledgers."""

import json
import os

import pytest

from grimoire import ledger, lorebookcore

GLOSSARY = "## Hydra tax\nClosing one item opens two.\n\n## Fup\nNot a typo.\n"
FINGERPRINT = "0123abcd"


@pytest.fixture
def entries():
    return {entry.id: entry for entry in lorebookcore.parse(GLOSSARY, name="glossary")}

def answer_line(term, answer, *, v=FINGERPRINT, d=None, word=None):
    """An answer line as Raven writes one; `d` defaults to the digest of the term as it is now."""
    words = lorebookcore.terms({e.id: e for e in lorebookcore.parse(GLOSSARY, name="g")})[term] if word is None else (word,)
    return {"id": term, "v": v, "status": "ok", "answer": answer,
            "d": ledger.digest(ledger.render(term, words[-1])) if d is None else d}

def failure_line(term, *, v=FINGERPRINT):
    return {"id": term, "v": v, "status": "failed", "error": "asked again on request"}

def write_ledger(directory, lines, *, fingerprint=FINGERPRINT, mtime=None):
    path = directory / f"{ledger.LEDGER_NAME}-{fingerprint}.jsonl"
    path.write_text("".join((line if isinstance(line, str) else json.dumps(line)) + "\n" for line in lines),
                    encoding="utf-8")
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    return path

TAX = {"tax": {"English": {"forms": ["taxes", "taxed"], "stems": []}}}


class TestDigest:
    def test_it_matches_ravens(self):
        # Computed by Raven's own `lorebook_expansion._digest` at Raven eb95cff0, so that a ledger Raven wrote
        # reads as current here.
        assert ledger.digest(ledger.render("Hydra tax", "tax")) == "a175695e3b8490ea"
        assert ledger.digest(ledger.render("AI ethnography", "ethnography")) == "8cd90f280c33e254"


class TestLatest:
    def test_a_later_line_supersedes_an_earlier_one(self, tmp_path):
        path = write_ledger(tmp_path, [answer_line("Hydra tax", {"old": {}}), answer_line("Hydra tax", TAX)])
        assert ledger.latest(path)["Hydra tax"]["answer"] == TAX

    def test_it_skips_what_does_not_parse_and_what_is_another_ledgers(self, tmp_path):
        path = write_ledger(tmp_path, ['{"id": "Hydra tax", "v": "0123', answer_line("Fup", TAX, v="ffffffff"),
                                       "[1, 2]", answer_line("Hydra tax", TAX)])
        assert list(ledger.latest(path)) == ["Hydra tax"]


class TestAnswers:
    def test_a_current_answer_is_read(self, tmp_path, entries):
        write_ledger(tmp_path, [answer_line("Hydra tax", TAX)])
        assert ledger.answers(tmp_path, lorebookcore.terms(entries)) == {"Hydra tax": TAX}

    def test_an_answer_about_other_text_is_stale(self, tmp_path, entries):
        # The digest of the rendering Raven used before 2026-11-23, which asked about every word.
        write_ledger(tmp_path, [answer_line("Hydra tax", TAX, d=ledger.digest("Hydra tax — words: hydra, tax")),
                                answer_line("Fup", TAX, d=None)])
        found = ledger.answers(tmp_path, lorebookcore.terms(entries))
        assert "Fup" in found, "no answer was current, so this fixture cannot tell a stale one from a missing one"
        assert "Hydra tax" not in found

    def test_a_failure_retires_the_answer_before_it(self, tmp_path, entries):
        write_ledger(tmp_path, [answer_line("Hydra tax", TAX), failure_line("Hydra tax"),
                                failure_line("Fup"), answer_line("Fup", TAX)])
        assert list(ledger.answers(tmp_path, lorebookcore.terms(entries))) == ["Fup"]

    def test_the_newest_ledger_wins(self, tmp_path, entries):
        older = {"tax": {"English": {"forms": ["older"], "stems": []}}}
        newer = {"tax": {"English": {"forms": ["newer"], "stems": []}}}
        terms = lorebookcore.terms(entries)
        write_ledger(tmp_path, [answer_line("Hydra tax", older, v="aaaaaaaa")], fingerprint="aaaaaaaa", mtime=1_000)
        write_ledger(tmp_path, [answer_line("Hydra tax", newer, v="bbbbbbbb")], fingerprint="bbbbbbbb", mtime=2_000)
        assert ledger.answers(tmp_path, terms)["Hydra tax"] == newer
        os.utime(tmp_path / "expansions-aaaaaaaa.jsonl", (3_000, 3_000))
        assert ledger.answers(tmp_path, terms)["Hydra tax"] == older, "the winner did not follow the times"

    def test_a_newer_ledger_without_a_current_answer_does_not_hide_an_older_ones(self, tmp_path, entries):
        write_ledger(tmp_path, [answer_line("Hydra tax", TAX, v="aaaaaaaa")], fingerprint="aaaaaaaa", mtime=1_000)
        write_ledger(tmp_path, [failure_line("Hydra tax", v="bbbbbbbb")], fingerprint="bbbbbbbb", mtime=2_000)
        assert ledger.answers(tmp_path, lorebookcore.terms(entries)) == {"Hydra tax": TAX}

    def test_traces_and_state_files_are_not_read(self, tmp_path, entries):
        write_ledger(tmp_path, [answer_line("Hydra tax", TAX)], fingerprint=f"{FINGERPRINT}-traces")
        (tmp_path / f"expansions-{FINGERPRINT}.state.json").write_text("{}", encoding="utf-8")
        assert ledger.answers(tmp_path, lorebookcore.terms(entries)) == {}

    def test_a_missing_directory_has_no_answers(self, tmp_path, entries):
        assert ledger.answers(tmp_path / "nowhere", lorebookcore.terms(entries)) == {}
        assert ledger.answers(str(tmp_path / "nowhere"), lorebookcore.terms(entries)) == {}


class TestExpansionsFrom:
    FINNISH = {"kaupunki": {"Finnish": {"forms": ["kaupungissa"], "stems": ["kaupung"]},
                            "English": {"forms": [], "stems": ["kaupu"]}}}

    def test_stems_only_from_the_languages_named(self):
        assert ledger.expansions_from({"t": self.FINNISH})["kaupunki"].stems == ()
        assert ledger.expansions_from({"t": self.FINNISH}, stem_languages={"Finnish"})["kaupunki"].stems == ("kaupung",)

    def test_forms_from_every_language(self):
        both = {"tax": {"English": {"forms": ["taxes"]}, "Finnish": {"forms": ["taxeissa"]}}}
        assert set(ledger.expansions_from({"t": both})["tax"].forms) == {"taxes", "taxeissa"}

    def test_what_is_not_a_list_of_strings_is_left_out(self):
        messy = {"tax": {"English": {"forms": ["taxes", 3, None], "stems": "taxe"}, "Finnish": "no"}, "fup": []}
        assert ledger.expansions_from({"t": messy}, stem_languages={"English"}) == {
            "tax": lorebookcore.Expansion(forms=("taxes",), stems=())}

    def test_a_word_left_with_nothing_is_left_out(self):
        assert ledger.expansions_from({"t": {"tax": {"English": {"forms": [], "stems": []}}}}) == {}


class TestLoadExpansions:
    def test_an_inflected_term_fires_with_the_ledger_and_not_without(self, tmp_path, entries):
        text = "We keep paying hydra taxes."
        assert "hydra-tax" not in lorebookcore.find_matches(entries, text), \
            "the term fires without its forms, so this fixture cannot tell whether the ledger was read"
        write_ledger(tmp_path, [answer_line("Hydra tax", TAX)])
        expansions = ledger.load_expansions(tmp_path, entries)
        assert "hydra-tax" in lorebookcore.find_matches(entries, text, expansions=expansions)
