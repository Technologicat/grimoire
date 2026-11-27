// The TypeScript ledger reader, with the cases of grimoire's `grimoire/tests/test_ledger.py`.

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as ledger from "../src/ledger.ts";
import { type Entry, findMatches, parse, terms } from "../src/lorebookcore.ts";

const GLOSSARY = "## Hydra tax\nClosing one item opens two.\n\n## Fup\nNot a typo.\n";
const FINGERPRINT = "0123abcd";
const TAX = { tax: { English: { forms: ["taxes", "taxed"], stems: [] } } };

const entries: Map<string, Entry> = new Map(parse(GLOSSARY, { name: "glossary" }).map((e) => [e.id, e]));
let folder: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "grimoire-ledger-"));
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

/** An answer line as Raven writes one; `d` defaults to the digest of the term as it is now. */
function answerLine(term: string, answer: unknown, { v = FINGERPRINT, d }: { v?: string; d?: string } = {}) {
  const words = terms(entries).get(term)!;
  return { id: term, v, status: "ok", answer, d: d ?? ledger.digest(ledger.render(term, words[words.length - 1]!)) };
}

function failureLine(term: string, { v = FINGERPRINT } = {}) {
  return { id: term, v, status: "failed", error: "asked again on request" };
}

function writeLedger(lines: unknown[], { fingerprint = FINGERPRINT, mtime }: { fingerprint?: string; mtime?: number } = {}) {
  const path = join(folder, `${ledger.LEDGER_NAME}-${fingerprint}.jsonl`);
  writeFileSync(path, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line)) + "\n").join(""), "utf-8");
  if (mtime !== undefined) utimesSync(path, mtime, mtime);
  return path;
}

describe("digest", () => {
  test("it matches Raven's", () => {
    // Computed by Raven's own `lorebook_expansion._digest` at Raven eb95cff0.
    expect(ledger.digest(ledger.render("Hydra tax", "tax"))).toBe("a175695e3b8490ea");
    expect(ledger.digest(ledger.render("AI ethnography", "ethnography"))).toBe("8cd90f280c33e254");
  });
});

describe("latest", () => {
  test("a later line supersedes an earlier one", () => {
    const path = writeLedger([answerLine("Hydra tax", { old: {} }), answerLine("Hydra tax", TAX)]);
    expect(ledger.latest(path).get("Hydra tax")!.answer).toEqual(TAX);
  });

  test("it skips what does not parse, and what is another ledger's", () => {
    const path = writeLedger(['{"id": "Hydra tax", "v": "0123', answerLine("Fup", TAX, { v: "ffffffff" }), "[1, 2]",
      answerLine("Hydra tax", TAX)]);
    expect([...ledger.latest(path).keys()]).toEqual(["Hydra tax"]);
  });
});

describe("answers", () => {
  test("a current answer is read", () => {
    writeLedger([answerLine("Hydra tax", TAX)]);
    expect(ledger.answers(folder, terms(entries))).toEqual(new Map([["Hydra tax", TAX]]));
  });

  test("an answer about other text is stale", () => {
    // The digest of the rendering Raven used before 2026-11-23, which asked about every word.
    writeLedger([answerLine("Hydra tax", TAX, { d: ledger.digest("Hydra tax — words: hydra, tax") }), answerLine("Fup", TAX)]);
    const found = ledger.answers(folder, terms(entries));
    expect(found.has("Fup"), "no answer was current, so this fixture cannot tell a stale one from a missing one").toBe(true);
    expect(found.has("Hydra tax")).toBe(false);
  });

  test("a failure retires the answer before it", () => {
    writeLedger([answerLine("Hydra tax", TAX), failureLine("Hydra tax"), failureLine("Fup"), answerLine("Fup", TAX)]);
    expect([...ledger.answers(folder, terms(entries)).keys()]).toEqual(["Fup"]);
  });

  test("the newest ledger wins", () => {
    const older = { tax: { English: { forms: ["older"], stems: [] } } };
    const newer = { tax: { English: { forms: ["newer"], stems: [] } } };
    writeLedger([answerLine("Hydra tax", older, { v: "aaaaaaaa" })], { fingerprint: "aaaaaaaa", mtime: 1_000 });
    writeLedger([answerLine("Hydra tax", newer, { v: "bbbbbbbb" })], { fingerprint: "bbbbbbbb", mtime: 2_000 });
    expect(ledger.answers(folder, terms(entries)).get("Hydra tax")).toEqual(newer);
    utimesSync(join(folder, "expansions-aaaaaaaa.jsonl"), 3_000, 3_000);
    expect(ledger.answers(folder, terms(entries)).get("Hydra tax"), "the winner did not follow the times").toEqual(older);
  });

  test("a newer ledger without a current answer does not hide an older one's", () => {
    writeLedger([answerLine("Hydra tax", TAX, { v: "aaaaaaaa" })], { fingerprint: "aaaaaaaa", mtime: 1_000 });
    writeLedger([failureLine("Hydra tax", { v: "bbbbbbbb" })], { fingerprint: "bbbbbbbb", mtime: 2_000 });
    expect(ledger.answers(folder, terms(entries))).toEqual(new Map([["Hydra tax", TAX]]));
  });

  test("traces and state files are not read", () => {
    writeLedger([answerLine("Hydra tax", TAX)], { fingerprint: `${FINGERPRINT}-traces` });
    writeFileSync(join(folder, `expansions-${FINGERPRINT}.state.json`), "{}", "utf-8");
    expect(ledger.answers(folder, terms(entries)).size).toBe(0);
  });

  test("a missing directory has no answers", () => {
    expect(ledger.answers(join(folder, "nowhere"), terms(entries)).size).toBe(0);
  });
});

describe("expansionsFrom", () => {
  const FINNISH = {
    kaupunki: { Finnish: { forms: ["kaupungissa"], stems: ["kaupung"] }, English: { forms: [], stems: ["kaupu"] } },
  };

  test("stems only from the languages named", () => {
    expect(ledger.expansionsFrom(new Map([["t", FINNISH]])).get("kaupunki")!.stems).toEqual([]);
    expect(ledger.expansionsFrom(new Map([["t", FINNISH]]), { stemLanguages: ["Finnish"] }).get("kaupunki")!.stems)
      .toEqual(["kaupung"]);
  });

  test("forms from every language", () => {
    const both = { tax: { English: { forms: ["taxes"] }, Finnish: { forms: ["taxeissa"] } } };
    expect(new Set(ledger.expansionsFrom(new Map([["t", both]])).get("tax")!.forms)).toEqual(new Set(["taxes", "taxeissa"]));
  });

  test("what is not a list of strings is left out", () => {
    const messy = { tax: { English: { forms: ["taxes", 3, null], stems: "taxe" }, Finnish: "no" }, fup: [] };
    expect(ledger.expansionsFrom(new Map([["t", messy]]), { stemLanguages: ["English"] }))
      .toEqual(new Map([["tax", { forms: ["taxes"], stems: [] }]]));
  });

  test("a word left with nothing is left out", () => {
    expect(ledger.expansionsFrom(new Map([["t", { tax: { English: { forms: [], stems: [] } } }]])).size).toBe(0);
  });
});

describe("loadExpansions", () => {
  test("an inflected term fires with the ledger and not without", () => {
    const text = "We keep paying hydra taxes.";
    expect(findMatches(entries, text).has("hydra-tax"),
      "the term fires without its forms, so this fixture cannot tell whether the ledger was read").toBe(false);
    writeLedger([answerLine("Hydra tax", TAX)]);
    const expansions = ledger.loadExpansions(folder, entries);
    expect(findMatches(entries, text, { expansions }).has("hydra-tax")).toBe(true);
  });
});
