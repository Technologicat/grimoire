// The conformance cases, `core/tests/lorebook_conformance.json`, against the translation. A port of Raven's runner,
// `core/tests/test_lorebookcore.py`, which is the reference for what each section's fields mean.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import * as core from "../src/lorebookcore.ts";
import { len } from "../src/pystr.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the cases are JSON, read by field as Raven's runner reads them
type Case = Record<string, any>;
const CASES: Case = JSON.parse(readFileSync(new URL("../../../core/tests/lorebook_conformance.json", import.meta.url), "utf-8"));

/** A case's glossary: the name of one in the file's `glossaries`, or its own lines. */
function textOf(glossary: string | string[]): string {
  const lines: string[] = typeof glossary === "string" ? CASES.glossaries[glossary] : glossary;
  return lines.join("\n") + "\n";
}

function entriesOf(glossary: string | string[]): Map<string, core.Entry> {
  return new Map(core.parse(textOf(glossary), { name: "glossary" }).map((entry) => [entry.id, entry]));
}

/** Expansions as a generator suggests them, cleaned as the core cleans them. */
function expansionsOf(raw: Record<string, { forms: string[]; stems: string[] }> | null): Map<string, core.Expansion> {
  return new Map(Object.entries(raw ?? {}).map(([word, given]) => [word, core.cleanExpansion(word, given.forms, given.stems)]));
}

function cases(section: string): [string, Case][] {
  return (CASES[section] as Case[]).map((theCase) => [theCase.name as string, theCase]);
}

// The cases name the Python fields; these are the translation's names for the ones that differ.
const FIELD: Record<string, keyof core.Entry> = { id: "id", title: "title", content: "content", order: "order" };

describe("parse", () => {
  test.each(cases("parse"))("%s", (_, c) => {
    const entries = core.parse(textOf(c.glossary), { name: c.file_name, entryLevel: c.entry_level, firstOrder: c.first_order });
    expect(entries.map((entry) => entry.title)).toEqual(c.titles);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    for (const [id, wanted] of Object.entries(c.entries ?? {}) as [string, Case][]) {
      const entry = byId.get(id)!;
      for (const [key, value] of Object.entries(wanted)) {
        if (key === "content_includes") {
          for (const part of value) expect(entry.content).toContain(part);
        } else if (key === "content_ends_with") {
          expect(entry.content.endsWith(value)).toBe(true);
        } else if (key === "content_not_ends_with") {
          expect(entry.content.endsWith(value)).toBe(false);
        } else if (key === "anchors_include") {
          expect(entry.anchors).toEqual(expect.arrayContaining(value));
        } else if (key === "aliases" || key === "crossrefs") {
          expect([...entry[key]]).toEqual(value);
        } else {
          const field = FIELD[key];
          expect(field, `the runner does not know the field '${key}'`).toBeDefined();
          expect(entry[field!]).toEqual(value);
        }
      }
    }
  });
});

describe("slugify", () => {
  test.each(CASES.slugify as [string, string][])("%s", (title, slug) => {
    expect(core.slugify(title)).toBe(slug);
  });
});

describe("load", () => {
  test.each(cases("load"))("%s", (_, c) => {
    const folder = mkdtempSync(join(tmpdir(), "grimoire-load-"));
    try {
      for (const [name, lines] of Object.entries(c.files) as [string, string[]][]) {
        writeFileSync(join(folder, name), lines.join("\n") + "\n", "utf-8");
      }
      const [entries, problems] = core.load(folder, { entryLevels: c.entry_levels ?? {} });
      expect([...entries.keys()]).toEqual(c.ids);
      expect([...problems.keys()].sort()).toEqual(c.problem_files);
      if ("orders" in c) {
        expect([...entries.values()].map((entry) => entry.order)).toEqual(c.orders);
      }
      for (const [id, content] of Object.entries(c.contents ?? {})) {
        expect(entries.get(id)!.content).toBe(content);
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("find_matches", () => {
  test.each(cases("find_matches"))("%s", (_, c) => {
    const found = core.findMatches(entriesOf(c.glossary), c.text, { expansions: expansionsOf(c.expansions) });
    expect([...found.keys()].sort()).toEqual(c.ids);
    for (const [id, wording] of Object.entries(c.wording ?? {})) {
      expect(found.get(id)!.wording).toBe(wording);
    }
  });
});

describe("clean_expansion", () => {
  test.each(cases("clean_expansion"))("%s", (_, c) => {
    const cleaned = core.cleanExpansion(c.word, c.forms, c.stems);
    expect({ forms: [...cleaned.forms], stems: [...cleaned.stems] }).toEqual(c.expect);
  });
});

describe("select", () => {
  test.each(cases("select"))("%s", (_, c) => {
    // Python's `len`, code points, as the cases count tokens.
    expect(CASES.token_count.startsWith("characters"), "this runner counts tokens as characters").toBe(true);
    const firings = core.select(entriesOf(c.glossary), c.text, {
      countTokens: len, budget: c.budget, maxDepth: c.max_depth, alreadyFired: c.already_fired,
      expansions: expansionsOf(c.expansions),
    });
    expect(firings.map((f) => ({ id: f.entry.id, depth: f.depth, wording: f.maybeWording, via: f.maybeVia }))).toEqual(c.firings);
  });
});

describe("lookup", () => {
  test.each(cases("lookup"))("%s", (_, c) => {
    const entries = entriesOf(c.glossary);
    const expansions = expansionsOf(c.expansions);
    const found = core.lookup(entries, c.term, { expansions });
    expect(found.maybeEntry ? found.maybeEntry.id : null).toBe(c.entry);
    expect(found.exact).toBe(c.exact);
    expect([...found.candidates].sort()).toEqual(c.candidates);
    expect([...found.mentionedIn]).toEqual(c.mentioned_in);
    const answer = core.answer(entries, c.term, { expansions });
    if ("answer" in c) expect(answer).toBe(c.answer);
    if ("answer_starts_with" in c) expect(answer.startsWith(c.answer_starts_with)).toBe(true);
    for (const part of c.answer_contains ?? []) expect(answer).toContain(part);
  });
});

describe("the runner", () => {
  test("covers every section of the cases", () => {
    // A section added in Raven, and not read here, would pass by never being run.
    const read = ["parse", "slugify", "load", "find_matches", "clean_expansion", "select", "lookup"];
    const sections = Object.keys(CASES).filter((key) => Array.isArray(CASES[key]));
    expect(sections.sort()).toEqual(read.sort());
  });
});
