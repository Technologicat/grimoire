// The lorebook's inflected forms, read from Raven's sweep ledgers. A translation of grimoire's `lib/ledger.py`,
// which is the reference: see its docstrings for the rules, and Raven's `sweep-ledger.md` for the format.
//
//     const expansions = loadExpansions(DEFAULT_DIRECTORY, entries);
//     findMatches(entries, text, { expansions });

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cleanExpansion, type Entry, type Expansion, terms } from "./lorebookcore.ts";

export const DEFAULT_DIRECTORY = join(homedir(), ".config", "raven", "librarian", "lorebook_expansion");
export const LEDGER_NAME = "expansions";

/** A term as the prompt shows it, asking for the forms of `word`, the term's last word. */
export function render(term: string, word: string): string {
  return `${term} — inflect: ${word}`;
}

/** The digest a ledger keeps of an item as it was asked: sixteen hex digits of its SHA-256. */
export function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

type Line = Record<string, unknown>;

/** The latest line for each item in one ledger, answered or failed, keyed by id. Only lines carrying the
 * fingerprint the file is named for count; a line that does not parse is skipped. */
export function latest(path: string): Map<string, Line> {
  const stem = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1).replace(/\.jsonl$/, "");
  const fingerprint = stem.slice(stem.lastIndexOf("-") + 1);
  const out = new Map<string, Line>();
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a run killed mid-write leaves one
    }
    if (isRecord(entry) && entry.v === fingerprint && typeof entry.id === "string") {
      out.set(entry.id, entry);
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The current answer for each term, from every expansions ledger in `directory`: the latest line for its term in
 * its ledger, answered, with a digest matching the term as it is now, the most recently modified ledger's winning.
 * `terms`: as `terms` (in the core) gives them, term -> its words. A missing directory has none. */
export function answers(directory: string, theTerms: ReadonlyMap<string, readonly string[]>): Map<string, Line> {
  const folder = directory === "~" || directory.startsWith("~/") ? homedir() + directory.slice(1) : directory;
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return new Map();
  }
  // The traces file shares the prefix, so it is told apart by the fingerprint, which is eight hex digits.
  const ledgers = names
    .filter((name) => /^expansions-[0-9a-f]{8}\.jsonl$/.test(name))
    .map((name) => join(folder, name))
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((x, y) => x.mtime - y.mtime); // oldest first, so the newest wins
  const digests = new Map<string, string>();
  for (const [term, words] of theTerms) {
    if (words.length > 0) {
      digests.set(term, digest(render(term, words[words.length - 1]!)));
    }
  }
  const out = new Map<string, Line>();
  for (const { path } of ledgers) {
    for (const [term, entry] of latest(path)) {
      if (digests.has(term) && entry.status === "ok" && entry.d === digests.get(term) && isRecord(entry.answer)) {
        out.set(term, entry.answer);
      }
    }
  }
  return out;
}

/** Expansions, by key word, from answers as `answers` gives them: each word's forms and stems, cleaned. Forms come
 * from every language, stems only from `stemLanguages`. A word in several terms gets what all of them gave it; a
 * word left with neither forms nor stems is left out. */
export function expansionsFrom(
  theAnswers: ReadonlyMap<string, Line>,
  { stemLanguages = [] }: { stemLanguages?: Iterable<string> } = {},
): Map<string, Expansion> {
  const stemming = new Set(stemLanguages);
  const forms = new Map<string, string[]>();
  const stems = new Map<string, string[]>();
  for (const answer of theAnswers.values()) {
    for (const [word, byLanguage] of Object.entries(answer)) {
      if (!isRecord(byLanguage)) {
        continue;
      }
      for (const [language, given] of Object.entries(byLanguage)) {
        if (!isRecord(given)) {
          continue;
        }
        forms.set(word, [...(forms.get(word) ?? []), ...strings(given.forms)]);
        if (stemming.has(language)) {
          stems.set(word, [...(stems.get(word) ?? []), ...strings(given.stems)]);
        }
      }
    }
  }
  const out = new Map<string, Expansion>();
  for (const [word, wordForms] of forms) {
    const expansion = cleanExpansion(word, wordForms, stems.get(word) ?? []);
    if (expansion.forms.length > 0 || expansion.stems.length > 0) {
      out.set(word, expansion);
    }
  }
  return out;
}

/** The strings in `value`, if it is an array; anything else a model's answer put there is left out. */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** The expansions for `entries`, from the ledgers in `directory`: `answers`, then `expansionsFrom`. */
export function loadExpansions(
  directory: string,
  entries: ReadonlyMap<string, Entry>,
  { stemLanguages = [] }: { stemLanguages?: Iterable<string> } = {},
): Map<string, Expansion> {
  return expansionsFrom(answers(directory, terms(entries)), { stemLanguages });
}
