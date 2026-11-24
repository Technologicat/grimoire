"""Ask an LLM for the inflected forms of the lorebook's terms, and keep them in a ledger Raven can read too.

    grimoire-expand --lorebook ~/lorebook --url http://localhost:8080
    grimoire-expand --lorebook ~/lorebook --url http://localhost:8080 --language English=forms --language Finnish=stems

Any OpenAI-compatible endpoint will do. Each term's last word is asked about, ten terms per request, with
Raven's prompt, and the answers go to a ledger in Raven's format (Raven's `sweep-ledger.md`), in Raven's folder
by default: where grimoire's ports, and Raven, read them. A run asks only the terms without a current answer,
so an interrupted run is resumed by running it again, and a run after an edit asks only the edited terms.

Standard library only, beside copies of `lorebookcore` and `ledger`, and Raven's prompt in `prompts/` beside the
core.
"""

__all__ = ["DEFAULT_LANGUAGES", "BATCH_SIZE",
           "instruction", "material", "fingerprint", "header",
           "parse_reply", "salvage",
           "Endpoint", "run",
           "main"]

import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import sys
import urllib.request
from collections.abc import Callable, Mapping
from typing import Any

import ledger
import lorebookcore

DEFAULT_LANGUAGES = {"English": "forms"}  # Raven's default
BATCH_SIZE = 10  # Raven's
RETRIES = 2  # more passes, within one run, over the terms that failed
GIVE_UP_AFTER = 3  # batches in a row that fail outright, as a backend that has gone away makes them

PROMPT = pathlib.Path(lorebookcore.__file__).parent / "prompts" / "lorebook_expansion.md"
RAVEN_OVERRIDE = pathlib.Path.home() / ".config" / "raven" / "librarian" / "prompts" / "lorebook_expansion.md"


# --------------------------------------------------------------------------------
# The question, and the instrument it makes

def instruction() -> str:
    """The prompt's instruction: Raven's user override if there is one, as Raven reads it, else the shipped one."""
    # The override as well, so that a user who has edited the prompt for Raven asks the same question here,
    # under the same fingerprint.
    path = RAVEN_OVERRIDE if RAVEN_OVERRIDE.exists() else PROMPT
    return path.read_text(encoding="utf-8").strip()

def material(languages: Mapping[str, str]) -> str:
    """The question the terms are asked with, without the terms: the instruction, and the languages."""
    described = {"forms": "forms", "stems": "forms and stems"}
    listing = "\n".join(f"- {language}: {described[kind]}" for language, kind in languages.items())
    return f"{instruction()}\n\nLanguages:\n{listing}"

def fingerprint(material: str, *, model_id: str, quantization: str | None = None) -> str:
    """The ledger's fingerprint, eight hex digits, computed as Raven's `sweep.fingerprint` does."""
    parts = (material, f"model={model_id}", f"quantization={quantization}", "declared=None")
    return hashlib.sha256("\x00".join(parts).encode("utf-8")).hexdigest()[:8]

def header(*, url: str, model_id: str, quantization: str | None) -> dict:
    """A run's header, with the fields Raven's `sweep.instrument_header` records."""
    reported = {"model_id": model_id, "label": None, "quantization": quantization, "bits_per_weight": None,
                "load_config": None}
    return {"backend_url": url, "backend_flavor": "generic", "model_requested": model_id, **reported,
            "not_reported": sorted(name for name, value in reported.items() if value is None),
            "declared": "not stated", "written_by": "grimoire-expand"}


# --------------------------------------------------------------------------------
# The reply

_NUMBERED_KEY = re.compile(r'\s*,?\s*"(\d+)"\s*:\s*')
_THINKING = re.compile(r"^\s*<think>.*?</think>", re.DOTALL)

def salvage(text: str) -> dict[str, Any]:
    """The complete entries of a JSON object keyed by number, from a reply that does not parse as a whole.

    Reads `"1": {...}, "2": {...}` from the first `{` on, one value at a time, and stops at the first that is
    not complete. Returns them by key; `{}` when not even the first is. As Raven's `lorebook_expansion.salvage`.
    """
    decoder = json.JSONDecoder()
    start = text.find("{")
    found: dict[str, Any] = {}
    if start == -1:
        return found
    position = start + 1
    while (match := _NUMBERED_KEY.match(text, position)) is not None:
        try:
            value, position = decoder.raw_decode(text, match.end())
        except json.JSONDecodeError:
            break
        found[match.group(1)] = value
    return found

def parse_reply(text: str) -> dict[str, Any]:
    """The answers in a model's reply, by term number, as far as they can be read.

    Tolerates a thinking block before the answer, a code fence around it, and prose around the JSON; a reply
    that ran on and never closed gives the terms complete before it stopped.
    """
    text = _THINKING.sub("", text).strip()
    fenced = re.search(r"```(?:json)?\s*(.+?)\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1).strip()
    for candidate in (text, text[text.find("{"):text.rfind("}") + 1]):
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        return parsed if isinstance(parsed, dict) else {}
    return salvage(text)

def _answer_for(got: Any, word: str, languages: Mapping[str, str]) -> dict | None:
    """One term's answer as the ledger keeps it, per language as the model gave it; `None` if it gave none."""
    if not isinstance(got, dict) or not isinstance(got.get(word), dict):
        return None
    by_language = got[word]
    def strings(value: Any) -> list[str]:
        return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []
    return {word: {language: {"forms": strings(by_language[language].get("forms")),
                              "stems": strings(by_language[language].get("stems"))}
                   for language in languages if isinstance(by_language.get(language), dict)}}


# --------------------------------------------------------------------------------
# The endpoint

class Endpoint:
    """An OpenAI-compatible chat completions endpoint.

    `url`: the server, such as `http://localhost:8080`; a trailing `/v1` is optional.
    `maybe_api_key`: sent as a bearer token, for a server that wants one.
    `timeout`: seconds to wait for one reply.
    """
    def __init__(self, url: str, *, maybe_api_key: str | None = None, timeout: float = 600.0):
        self.url = url.rstrip("/").removesuffix("/v1")
        self.maybe_api_key = maybe_api_key
        self.timeout = timeout

    def _request(self, path: str, maybe_payload: dict | None = None) -> dict:
        headers = {"Content-Type": "application/json"}
        if self.maybe_api_key:
            headers["Authorization"] = f"Bearer {self.maybe_api_key}"
        data = json.dumps(maybe_payload).encode("utf-8") if maybe_payload is not None else None
        request = urllib.request.Request(f"{self.url}/v1/{path}", data=data, headers=headers)
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            return json.loads(response.read().decode("utf-8"))

    def model(self) -> str:
        """The id of the first model the server lists, which on a server running one is the one it runs."""
        models = self._request("models").get("data") or []
        if not models:
            raise RuntimeError(f"{self.url} lists no models")
        return models[0]["id"]

    def ask(self, model: str, prompt: str) -> str:
        """The reply to `prompt`, as one user message, with thinking off."""
        payload = {"model": model, "messages": [{"role": "user", "content": prompt}],
                   "reasoning_effort": "none"}  # as Raven sends it, to every backend
        return self._request("chat/completions", payload)["choices"][0]["message"]["content"] or ""


# --------------------------------------------------------------------------------
# The run

def _append(path: pathlib.Path, payload: dict) -> None:
    """Append a line, starting a fresh one if a run killed mid-write left the last unfinished."""
    path.parent.mkdir(parents=True, exist_ok=True)
    unfinished = path.exists() and path.stat().st_size > 0 and not path.read_bytes().endswith(b"\n")
    with path.open("a", encoding="utf-8") as f:
        f.write(("\n" if unfinished else "") + json.dumps(payload, ensure_ascii=False) + "\n")

def run(entries: Mapping[str, lorebookcore.Entry],
        endpoint: Endpoint,
        *,
        model: str,
        languages: Mapping[str, str] = DEFAULT_LANGUAGES,
        directory: str | pathlib.Path = ledger.DEFAULT_DIRECTORY,
        quantization: str | None = None,
        batch_size: int = BATCH_SIZE,
        report: Callable[[str], None] = print) -> tuple[int, int]:
    """Ask for the terms of `entries` that have no current answer, and write the answers to the ledger.

    `model`: the model id, as the server reports it; it goes into the ledger's fingerprint.
    `languages`: language -> `"forms"` or `"stems"`, as Raven's `lorebook_languages`.
    `directory`: where the ledger goes.
    `quantization`: the model's quantization, if known, for the fingerprint; servers do not report it.
    `report`: called with a line of progress after each batch.

    Returns `(answered, total)`: the terms with a current answer after the run, and all the terms.
    """
    the_material = material(languages)
    the_fingerprint = fingerprint(the_material, model_id=model, quantization=quantization)
    path = pathlib.Path(directory).expanduser() / f"{ledger.LEDGER_NAME}-{the_fingerprint}.jsonl"
    traces = path.with_name(f"{path.stem}-traces.jsonl")
    items = {term: words[-1] for term, words in lorebookcore.terms(entries).items() if words}
    digests = {term: ledger.digest(ledger.render(term, word)) for term, word in items.items()}

    def unanswered() -> list[str]:
        latest = ledger.latest(path) if path.exists() else {}
        return [term for term in items
                if not (latest.get(term, {}).get("status") == "ok" and latest[term].get("d") == digests[term])]

    todo = unanswered()
    report(f"{path.name}: {len(items) - len(todo)} of {len(items)} terms already answered.")
    if todo:
        _append(path, {"header": header(url=endpoint.url, model_id=model, quantization=quantization),
                       "v": the_fingerprint, "started": datetime.datetime.now().isoformat(timespec="seconds")})
    for attempt in range(1 + RETRIES):
        if not todo:
            break
        if attempt:
            report(f"Asking again for the {len(todo)} that failed ({attempt} of {RETRIES}).")
        batches = [todo[i:i + batch_size] for i in range(0, len(todo), batch_size)]
        failed_in_a_row = 0
        for number, batch in enumerate(batches, start=1):
            listing = "\n".join(f"{n}. {ledger.render(term, items[term])}" for n, term in enumerate(batch, start=1))
            prompt = f"{the_material}\n\nTerms:\n{listing}"
            try:
                reply = endpoint.ask(model, prompt)
            except (OSError, ValueError, KeyError, IndexError, TypeError) as exc:  # a dead server, or a malformed response
                for term in batch:
                    _append(path, {"id": term, "v": the_fingerprint, "status": "failed",
                                   "error": f"{type(exc).__name__}: {exc}"})
                failed_in_a_row += 1
                report(f"Batch {number} of {len(batches)}: failed, {type(exc).__name__}: {exc}")
                if failed_in_a_row >= GIVE_UP_AFTER:
                    report(f"Stopping: {GIVE_UP_AFTER} batches in a row failed. Run again to resume.")
                    return len(items) - len(unanswered()), len(items)
                continue
            failed_in_a_row = 0
            got = parse_reply(reply)
            answered = 0
            for n, term in enumerate(batch, start=1):
                maybe_answer = _answer_for(got.get(str(n)), items[term], languages)
                if maybe_answer is None:
                    _append(path, {"id": term, "v": the_fingerprint, "status": "failed",
                                   "error": "the reply had no answer for this term"})
                else:
                    _append(path, {"id": term, "v": the_fingerprint, "status": "ok", "answer": maybe_answer,
                                   "d": digests[term]})
                    answered += 1
            _append(traces, {"ids": batch, "v": the_fingerprint, "turns": [{"prompt": prompt, "reply": reply}]})
            report(f"Batch {number} of {len(batches)}: {answered} of {len(batch)} answered.")
        todo = unanswered()
    done = len(items) - len(todo)
    report(f"Done: {done} of {len(items)} terms answered.")
    return done, len(items)


def _language(text: str) -> tuple[str, str]:
    name, _, kind = text.partition("=")
    kind = kind or "forms"
    if not name or kind not in ("forms", "stems"):
        raise argparse.ArgumentTypeError(f"expected NAME=forms or NAME=stems, got {text!r}")
    return name, kind

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="grimoire-expand", description=__doc__.split("\n\n")[0])
    parser.add_argument("--lorebook", required=True, type=pathlib.Path, help="the lorebook folder")
    parser.add_argument("--url", required=True, help="an OpenAI-compatible server, such as http://localhost:8080")
    parser.add_argument("--model", help="the model id (default: the first the server lists)")
    parser.add_argument("--language", action="append", type=_language, metavar="NAME=forms|stems",
                        help="a language to ask for, repeatable; `stems` also asks for stems "
                             "(default: English=forms)")
    parser.add_argument("--ledger-dir", type=pathlib.Path, default=ledger.DEFAULT_DIRECTORY,
                        help="where the ledgers go (default: %(default)s)")
    parser.add_argument("--quantization", help="the model's quantization, if known: it goes into the "
                                               "ledger's fingerprint, as Raven's does when the server reports it")
    parser.add_argument("--api-key-env", metavar="VAR", help="the environment variable holding an API key")
    args = parser.parse_args(argv)

    entries, problems = lorebookcore.load(args.lorebook)
    for filename, problem in problems.items():
        print(f"{filename}: {problem}", file=sys.stderr)
    if not entries:
        print(f"No entries in {args.lorebook}.", file=sys.stderr)
        return 1
    endpoint = Endpoint(args.url, maybe_api_key=os.environ.get(args.api_key_env) if args.api_key_env else None)
    try:
        model = args.model or endpoint.model()
    except (OSError, ValueError, KeyError, RuntimeError) as exc:
        print(f"Cannot ask {endpoint.url} for its model: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    print(f"Asking {model} at {endpoint.url}.")
    done, total = run(entries, endpoint, model=model, languages=dict(args.language or DEFAULT_LANGUAGES),
                      directory=args.ledger_dir, quantization=args.quantization)
    return 0 if done == total else 1


if __name__ == "__main__":
    sys.exit(main())
