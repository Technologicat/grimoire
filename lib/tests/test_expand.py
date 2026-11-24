"""Tests for `expand`, the ledger generator, against a fake OpenAI-compatible server."""

import http.server
import json
import re
import threading

import pytest

import expand
import ledger
import lorebookcore

GLOSSARY = "## Hydra tax\nClosing one item opens two.\n\n## Fup\nNot a typo.\n\n## Duolect\nTwo voices.\n"
TERM_LINE = re.compile(r"^(\d+)\. (.+) — inflect: (\S+)$", re.MULTILINE)


PLURALS = {"tax": "taxes", "fup": "fups", "duolect": "duolects"}  # plural

def plural_reply(prompt):
    """What a well-behaved model answers: every term asked, with its word's English plural."""
    return json.dumps({n: {word: {"English": {"forms": [PLURALS.get(word, word + "s")], "stems": []}}}
                       for n, _, word in TERM_LINE.findall(prompt)})

class FakeServer:
    """An OpenAI-compatible server in a thread. `respond(prompt)` gives the reply text, or an int for an HTTP
    error status; `prompts` records what was asked."""
    def __init__(self, respond=plural_reply, model="fake-model"):
        self.respond = respond
        self.prompts = []
        server = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def send(self, status, payload):
                body = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                self.send(200, {"data": [{"id": model}]})

            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                prompt = payload["messages"][0]["content"]
                server.prompts.append(prompt)
                server.last_payload = payload
                reply = server.respond(prompt)
                if isinstance(reply, int):
                    self.send(reply, {"error": "no"})
                else:
                    self.send(200, {"choices": [{"message": {"role": "assistant", "content": reply}}]})

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture(autouse=True)
def no_raven_override(monkeypatch, tmp_path):
    """The shipped prompt, whatever the machine running the tests has in Raven's override folder."""
    monkeypatch.setattr(expand, "RAVEN_OVERRIDE", tmp_path / "no-override.md")

@pytest.fixture
def entries():
    return {entry.id: entry for entry in lorebookcore.parse(GLOSSARY, name="glossary")}

@pytest.fixture
def server():
    the_server = FakeServer()
    yield the_server
    the_server.close()

def run(entries, server, directory, **kwargs):
    return expand.run(entries, expand.Endpoint(server.url), model="fake-model", directory=directory,
                      report=lambda line: None, **kwargs)


class TestInstrument:
    def test_the_fingerprint_matches_ravens(self):
        # Computed by Raven's own `lorebook_expansion.material` and `sweep.fingerprint` at Raven eb95cff0, from
        # the shipped prompt, so that a ledger written here is the one Raven would write, and reads.
        english = expand.material({"English": "forms"})
        finnish = expand.material({"English": "forms", "Finnish": "stems"})
        assert expand.fingerprint(english, model_id="flash-next") == "d808f74b"
        assert expand.fingerprint(english, model_id="qwen3.8-27b", quantization="Q4_K_M") == "9499e254"
        assert expand.fingerprint(finnish, model_id="flash-next") == "01308c24"
        assert expand.fingerprint(finnish, model_id="qwen3.8-27b", quantization="Q4_K_M") == "b82372dc"

    def test_ravens_override_of_the_prompt_is_used(self, monkeypatch, tmp_path):
        override = tmp_path / "override.md"
        override.write_text("Inflect these.\n", encoding="utf-8")
        monkeypatch.setattr(expand, "RAVEN_OVERRIDE", override)
        assert expand.material({"English": "forms"}) == "Inflect these.\n\nLanguages:\n- English: forms"


class TestParseReply:
    WANT = {"1": {"tax": {"English": {"forms": ["taxes"], "stems": []}}}}
    JSON = json.dumps(WANT)

    @pytest.mark.parametrize("reply", [JSON, f"```json\n{JSON}\n```", f"Here you go:\n{JSON}\nHope this helps.",
                                       f"<think>Plurals.</think>\n{JSON}"],
                             ids=["bare", "fenced", "prose around", "thinking first"])
    def test_the_answers_are_found(self, reply):
        assert expand.parse_reply(reply) == self.WANT

    def test_a_reply_that_ran_on_keeps_the_terms_complete_before_it_stopped(self):
        ran_on = '{"1": {"tax": {}}, "2": {"fup": {"English": {"forms": ["fups", "fups", "fups'
        assert expand.parse_reply(ran_on) == {"1": {"tax": {}}}

    def test_what_is_not_an_object_is_no_answers(self):
        assert expand.parse_reply("[1, 2, 3]") == {}
        assert expand.parse_reply("Sorry, I cannot.") == {}


class TestRun:
    def test_every_term_is_answered_into_a_ledger_the_reader_reads(self, entries, server, tmp_path):
        assert run(entries, server, tmp_path) == (3, 3)
        (path,) = tmp_path.glob("expansions-*[0-9a-f].jsonl")
        lines = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
        assert lines[0]["header"]["model_id"] == "fake-model"
        assert {line["id"] for line in lines[1:]} == {"Hydra tax", "Fup", "Duolect"}
        assert server.last_payload["reasoning_effort"] == "none"
        text = "Two hydra taxes."
        assert "hydra-tax" not in lorebookcore.find_matches(entries, text), \
            "the term fires without its forms, so this fixture cannot tell whether the ledger was read"
        expansions = ledger.load_expansions(tmp_path, entries)
        assert "hydra-tax" in lorebookcore.find_matches(entries, text, expansions=expansions)

    def test_only_the_last_word_is_asked_about(self, entries, server, tmp_path):
        run(entries, server, tmp_path)
        assert "1. Hydra tax — inflect: tax" in server.prompts[0]

    def test_a_second_run_asks_nothing_and_an_edit_asks_again(self, entries, server, tmp_path):
        run(entries, server, tmp_path)
        asked = len(server.prompts)
        assert run(entries, server, tmp_path) == (3, 3)
        assert len(server.prompts) == asked
        edited = {e.id: e for e in lorebookcore.parse(GLOSSARY.replace("## Fup", "## Fup sauce"), name="glossary")}
        run(edited, server, tmp_path)
        assert len(server.prompts) == asked + 1
        assert TERM_LINE.findall(server.prompts[-1]) == [("1", "Fup sauce", "sauce")]

    def test_a_term_left_out_of_the_reply_is_asked_again(self, entries, tmp_path):
        # The first reply answers only the first term; every later one answers all.
        calls = []
        def respond(prompt):
            calls.append(prompt)
            if len(calls) == 1:
                return json.dumps({"1": {"tax": {"English": {"forms": ["taxes"], "stems": []}}}})
            return plural_reply(prompt)
        the_server = FakeServer(respond=respond)
        try:
            assert run(entries, the_server, tmp_path) == (3, 3)
            assert len(calls) == 2
            assert [term for _, term, _ in TERM_LINE.findall(calls[1])] == ["Fup", "Duolect"]
        finally:
            the_server.close()

    def test_it_stops_after_three_batches_in_a_row_fail(self, entries, tmp_path):
        many = {e.id: e for e in lorebookcore.parse("".join(f"## Term{n}\nx\n\n" for n in range(6)), name="g")}
        the_server = FakeServer(respond=lambda prompt: 500)
        try:
            assert run(many, the_server, tmp_path, batch_size=1) == (0, 6)
            assert len(the_server.prompts) == 3
        finally:
            the_server.close()

    def test_a_dead_server_fails_the_run_without_raising(self, entries, tmp_path):
        endpoint = expand.Endpoint("http://127.0.0.1:9", timeout=2)  # the discard port: nothing listens
        assert expand.run(entries, endpoint, model="m", directory=tmp_path, report=lambda line: None) == (0, 3)

    def test_only_the_word_and_the_languages_asked_are_kept(self, entries, tmp_path):
        def chatty(prompt):
            return json.dumps({n: {word: {"English": {"forms": [word + "s"], "stems": ["x"]},
                                          "Klingon": {"forms": ["qa"], "stems": []}},
                                   "extra": {"English": {"forms": ["no"], "stems": []}}}
                               for n, _, word in TERM_LINE.findall(prompt)})
        the_server = FakeServer(respond=chatty)
        try:
            run(entries, the_server, tmp_path)
        finally:
            the_server.close()
        answers = ledger.answers(tmp_path, lorebookcore.terms(entries))
        assert answers["Hydra tax"] == {"tax": {"English": {"forms": ["taxs"], "stems": ["x"]}}}


class TestAppend:
    def test_a_line_left_unfinished_is_not_glued_to(self, tmp_path):
        path = tmp_path / "expansions-0123abcd.jsonl"
        path.write_text('{"id": "Fup", "v": "0123', encoding="utf-8")
        expand._append(path, {"id": "Hydra tax", "v": "0123abcd", "status": "ok", "answer": {}})
        assert list(ledger.latest(path)) == ["Hydra tax"]


class TestMain:
    def test_a_run_from_the_command_line(self, server, tmp_path):
        (tmp_path / "lorebook").mkdir()
        (tmp_path / "lorebook" / "glossary.md").write_text(GLOSSARY, encoding="utf-8")
        status = expand.main(["--lorebook", str(tmp_path / "lorebook"), "--url", f"{server.url}/v1",
                              "--ledger-dir", str(tmp_path / "ledgers"), "--language", "English=forms",
                              "--language", "Finnish=stems"])
        assert status == 0
        (path,) = (tmp_path / "ledgers").glob("expansions-*[0-9a-f].jsonl")
        assert path.stem.endswith(expand.fingerprint(expand.material({"English": "forms", "Finnish": "stems"}),
                                                     model_id="fake-model"))

    def test_a_bad_language_is_refused(self, tmp_path):
        with pytest.raises(SystemExit):
            expand.main(["--lorebook", str(tmp_path), "--url", "http://x", "--language", "Finnish=roots"])
