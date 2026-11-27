// The lorebook's core: parsing, matching, choosing what fires, and answering a lookup.
//
// A translation of Raven's `raven/librarian/lorebookcore.py`, which is the reference, held to the same conformance
// cases (`grimoire/tests/lorebook_conformance.json` in grimoire). The docstrings there are the full account of each
// function; the comments here keep the reasons that bear on the code, and say where the translation differs.
//
// Where Python and JavaScript disagree about strings, the translation sides with Python, through `pystr.ts`: its
// `\w`, its whitespace, `splitlines`, ordering by code point. Two differences are JavaScript's own and kept:
//   - Offsets (`Match.start`, `Match.end`) count UTF-16 units, as JavaScript indexes strings, where Python's count
//     code points. They agree on text without characters past U+FFFF, and each is right for slicing its own strings.
//   - Collections keyed by entry id are `Map`s, where Python's are dicts: a plain object would put an id that reads
//     as an integer ("42") ahead of the others, and the order of entries is part of the result.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getCloseMatches } from "./difflib.ts";
import {
  commonPrefixLength,
  compareCodePoints,
  codePoints,
  format,
  isAlpha,
  len,
  permutations,
  S,
  S_CHARS,
  splitlines,
  strip,
  W_CHARS,
} from "./pystr.ts";

/** The folder's own README, which says what goes there; never a source. */
export const README_FILENAME = "README.md";

/** One definition. As Python's `Entry`, which see; `source` is a path as a string. */
export interface Entry {
  readonly id: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly content: string;
  readonly crossrefs: readonly string[];
  readonly anchors: readonly string[];
  readonly source: string;
  readonly order: number;
}

/** The anchor GitHub gives a header with this text: lowercase, punctuation dropped, spaces as hyphens. */
export function slugify(text: string): string {
  return strip(text).toLowerCase().replace(new RegExp(`[^${W_CHARS}\\- ]`, "gu"), "").replaceAll(" ", "-");
}

function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

// ----------------------------------------
// Parsing

const HEADER = new RegExp(`^(#{1,6})${S}+(.*?)${S}*#*${S}*$`, "u");
const FENCE = new RegExp(`^${S}*(\`\`\`|~~~)`, "u");
const RULE = new RegExp(`^${S}*([-*_])(${S}*\\1){2,}${S}*$`, "u"); // a horizontal rule: `---`, `***`, `___`
const ALIASES = new RegExp(`^(.*?)${S}*\\(([^()]*)\\)${S}*$`, "u");
const CROSSREF = new RegExp(`\\]\\(#([^)${S_CHARS}]+)\\)`, "gu");

/** `[line index, level, text]` of each header, skipping fenced code, where a `#` is not one. */
function headersOf(lines: readonly string[]): [number, number, string][] {
  const headers: [number, number, string][] = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return;
    }
    const match = fenced ? null : HEADER.exec(line);
    if (match) {
      headers.push([index, match[1]!.length, match[2]!]);
    }
  });
  return headers;
}

function isBlank(line: string): boolean {
  return strip(line) === "" || RULE.test(line);
}

/** Split one Markdown file into entries. As Python's `parse(text, name=, source=, entry_level=, first_order=)`,
 * whose docstring gives the rule for where entries are. */
export function parse(
  text: string,
  { name, source, entryLevel, firstOrder = 0 }: { name: string; source?: string; entryLevel?: number | null; firstOrder?: number },
): Entry[] {
  const theSource = source ?? name;
  const lines = splitlines(text);
  const headers = headersOf(lines);
  if (headers.length === 0) {
    const content = strip(text);
    return content ? [makeEntry(name, content, theSource, firstOrder)] : [];
  }

  const hasContent = (number: number): boolean => {
    const start = headers[number]![0] + 1;
    const end = number + 1 < headers.length ? headers[number + 1]![0] : lines.length;
    return !lines.slice(start, end).every(isBlank);
  };

  const withContent = headers.map((_, number) => number).filter(hasContent);
  let level = entryLevel ?? null;
  if (level === null) {
    const top = withContent.filter((number) => headers[number]![1] === 1);
    const deeper = unique(withContent.map((number) => headers[number]![1]).filter((l) => l > 1)).sort((x, y) => x - y);
    level = top.length >= 2 || deeper.length === 0 ? 1 : deeper[0]!;
  }

  const entries: Entry[] = [];
  for (const number of withContent) {
    const [index, headerLevel, headerText] = headers[number]!;
    if (headerLevel !== level) {
      continue;
    }
    const later = headers.slice(number + 1).find(([, laterLevel]) => laterLevel <= level);
    const end = later ? later[0] : lines.length;
    const body = lines.slice(index + 1, end);
    while (body.length > 0 && isBlank(body[body.length - 1]!)) {
      body.pop(); // a trailing rule separates sections; it is not part of this one
    }
    entries.push(makeEntry(headerText, strip(body.join("\n")), theSource, firstOrder + entries.length));
  }
  return entries;
}

function makeEntry(headerText: string, content: string, source: string, order: number): Entry {
  let title = strip(headerText);
  let aliases: string[] = [];
  const match = ALIASES.exec(title);
  if (match && match[1]) {
    title = match[1];
    aliases = match[2]!.split(",").map(strip).filter((alias) => alias);
  }
  const anchors = unique([slugify(title), slugify(headerText)]); // the two coincide without aliases
  const crossrefs = unique([...content.matchAll(CROSSREF)].map((m) => slugify(m[1]!)));
  return { id: slugify(title), title, aliases, content, crossrefs, anchors, source, order };
}

/** Read every lorebook file in `directory`: each `*.md` but the folder's `README.md`, in name order. As Python's
 * `load(directory, entry_levels=)`: returns `[entries, problems]`, id -> entry in order and filename -> why it, or an
 * entry in it, could not be used. Two entries with one id keep the first; a missing directory is an empty lorebook. */
export function load(
  directory: string,
  { entryLevels = {} }: { entryLevels?: Readonly<Record<string, number>> } = {},
): [Map<string, Entry>, Map<string, string>] {
  const folder = directory === "~" || directory.startsWith("~/") ? homedir() + directory.slice(1) : directory;
  const entries = new Map<string, Entry>();
  const problems = new Map<string, string>();
  let names: string[];
  try {
    if (!statSync(folder).isDirectory()) {
      return [entries, problems];
    }
    names = readdirSync(folder);
  } catch {
    return [entries, problems];
  }
  // As Python's `pathlib.Path.glob("*.md")`: hidden files included, the case of the suffix as written.
  let order = 0;
  for (const filename of names.filter((n) => n.endsWith(".md")).sort(compareCodePoints)) {
    const path = join(folder, filename);
    if (filename === README_FILENAME || !isFile(path)) {
      continue;
    }
    let text: string;
    try {
      // Fatal, as Python's `read_text` is on a file that is not UTF-8, rather than quietly replacing characters.
      // A byte order mark is dropped, as Python's `utf-8-sig` drops it: `TextDecoder` does so unless told not to.
      text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
    } catch (error) {
      const { name, message } = error as Error;
      problems.set(filename, `cannot be read: ${name}: ${message}`);
      continue;
    }
    const stem = filename.slice(0, -".md".length);
    for (const entry of parse(text, { name: stem, source: path, entryLevel: entryLevels[filename] ?? null, firstOrder: order })) {
      order++;
      const earlier = entries.get(entry.id);
      if (earlier) {
        problems.set(filename, `'${entry.title}' is defined in '${basename(earlier.source)}' already; the first is kept`);
        continue;
      }
      entries.set(entry.id, entry);
    }
  }
  return [entries, problems];
}

/** Python's `Path.is_file()`: following symlinks, and `false` for one that leads nowhere. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

// ----------------------------------------
// Matching

// The math symbols beyond ASCII, Unicode category Sm, which count as word characters: the Python core's table,
// `_MATH_SYMBOLS`, as ranges for a `u`-flag class. Written out rather than `\p{Sm}`, which would follow the
// Unicode of whatever runs this rather than the core's; a test holds the two tables equal.
export const MATH_SYMBOLS =
  String.raw`\u{ac}\u{b1}\u{d7}\u{f7}\u{3f6}\u{606}-\u{608}\u{2044}\u{2052}\u{207a}-\u{207c}\u{208a}-\u{208c}` +
  String.raw`\u{2118}\u{2140}-\u{2144}\u{214b}\u{2190}-\u{2194}\u{219a}-\u{219b}\u{21a0}\u{21a3}\u{21a6}\u{21ae}` +
  String.raw`\u{21ce}-\u{21cf}\u{21d2}\u{21d4}\u{21f4}-\u{22ff}\u{2320}-\u{2321}\u{237c}\u{239b}-\u{23b3}` +
  String.raw`\u{23dc}-\u{23e1}\u{25b7}\u{25c1}\u{25f8}-\u{25ff}\u{266f}\u{27c0}-\u{27c4}\u{27c7}-\u{27e5}` +
  String.raw`\u{27f0}-\u{27ff}\u{2900}-\u{2982}\u{2999}-\u{29d7}\u{29dc}-\u{29fb}\u{29fe}-\u{2aff}` +
  String.raw`\u{2b30}-\u{2b44}\u{2b47}-\u{2b4c}\u{fb29}\u{fe62}\u{fe64}-\u{fe66}\u{ff0b}\u{ff1c}-\u{ff1e}\u{ff5c}` +
  String.raw`\u{ff5e}\u{ffe2}\u{ffe9}-\u{ffec}\u{10d8e}-\u{10d8f}\u{1cef0}\u{1d6c1}\u{1d6db}\u{1d6fb}\u{1d715}` +
  String.raw`\u{1d735}\u{1d74f}\u{1d76f}\u{1d789}\u{1d7a9}\u{1d7c3}\u{1eef0}-\u{1eef1}\u{1f8d0}-\u{1f8d8}`;
const WORD_CHAR = `[${W_CHARS}${MATH_SYMBOLS}]`;

// A word: letters, digits and math symbols, joined by internal hyphens or apostrophes (`co-pter`, `Chekhov's`),
// and keeping a trailing hyphen that nothing word-like follows — a suspended hyphen, as in "co- and re-", which is
// what lets the key `co-` match the prefix written on its own and not "co-pter" or "CO".
const WORD = new RegExp(`${WORD_CHAR}+(?:['-]${WORD_CHAR}+)*(?:-(?!${WORD_CHAR}))?`, "gu");
const WORD_WHOLE = new RegExp(`^${WORD_CHAR}+(?:['-]${WORD_CHAR}+)*$`, "u");
const WORD_PART = new RegExp(`${WORD_CHAR}+`, "gu");

type Unit = readonly [word: string, start: number, end: number];

function normalize(text: string): string {
  return text.replaceAll("’", "'").replaceAll("‘", "'"); // curly apostrophes, as typed by many editors
}

function words(text: string): Unit[] {
  return [...normalize(text).matchAll(WORD)].map((m) => [m[0], m.index, m.index + m[0].length] as const);
}

/** The words of a key, in the case they are matched in. `sentenceCase`: the phrase is a title, whose first letter is
 * capitalized as a sentence's would be rather than to make the word exact. */
function keyOf(phrase: string, { sentenceCase }: { sentenceCase: boolean }): string[] {
  const found = words(phrase).map(([word]) => word);
  // The first letter says nothing, so the rest of the word decides: `Hydra` is forgiving, while `EQ` and `AI` carry
  // an uppercase letter past the first and stay exact, as written. The first letter is a code point, as in Python.
  if (sentenceCase && found.length > 0) {
    const rest = codePoints(found[0]!).slice(1).join("");
    if (rest === rest.toLowerCase()) {
      found[0] = found[0]!.toLowerCase();
    }
  }
  return found;
}

function keysOf(entry: Entry): string[][] {
  return [keyOf(entry.title, { sentenceCase: true }), ...entry.aliases.map((alias) => keyOf(alias, { sentenceCase: false }))]
    .filter((key) => key.length > 0);
}

/** Every term the entries fire on, its title or an alias as written -> its words, as `findMatches` matches them. */
export function terms(entries: ReadonlyMap<string, Entry>): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const entry of entries.values()) {
    const phrases: [string, boolean][] = [[entry.title, true], ...entry.aliases.map((alias): [string, boolean] => [alias, false])];
    for (const [phrase, sentenceCase] of phrases) {
      const key = keyOf(phrase, { sentenceCase });
      const spelling = normalize(phrase);
      if (key.length > 0 && !found.has(spelling)) {
        found.set(spelling, key);
      }
    }
  }
  return found;
}

/** The other forms of one key word, which match where it is written inflected. As Python's `Expansion`, which see;
 * build one with `cleanExpansion`. */
export interface Expansion {
  readonly forms: readonly string[];
  readonly stems: readonly string[];
}

// A stem matches every word it begins, so a short one matches too many. One kept by `cleanExpansion` shares with its
// word all but the last `STEM_SLACK` letters, which is where Finnish inflection and consonant gradation act
// ("kaupunki", "kaupungissa"), and never fewer than `MIN_STEM`. Letters are code points, as in Python.
const STEM_SLACK = 2;
const MIN_STEM = 5;

function isExact(word: string): boolean {
  return word !== word.toLowerCase();
}

/** An `Expansion` of the key word `word`, from forms and stems as a generator suggested them. As Python's
 * `clean_expansion`, which says what is dropped. */
export function cleanExpansion(word: string, forms: Iterable<string>, stems: Iterable<string>): Expansion {
  const exact = isExact(word);
  const tidy = (candidates: Iterable<string>): string[] => {
    const out: string[] = [];
    for (const raw of candidates) {
      const candidate = exact ? strip(raw) : strip(raw).toLowerCase();
      if (candidate && WORD_WHOLE.test(candidate) && !out.includes(candidate)) {
        out.push(candidate);
      }
    }
    return out;
  };
  const needed = Math.max(MIN_STEM, len(word) - STEM_SLACK);
  const keptStems = tidy(stems).filter((stem) => commonPrefixLength(stem.toLowerCase(), word.toLowerCase()) >= needed);
  const keptForms = tidy(forms).filter((form) => form !== (exact ? word : word.toLowerCase()));
  return { forms: keptForms, stems: keptStems };
}

/** Whether `textWord` is `keyWord`, or one of its forms, or one of its stems followed by letters. */
function accepts(keyWord: string, textWord: string, maybeExpansion: Expansion | undefined, ignoreCase = false): boolean {
  const exact = isExact(keyWord) && !ignoreCase;
  const seen = exact ? textWord : textWord.toLowerCase();
  if (seen === (exact ? keyWord : keyWord.toLowerCase())) {
    return true;
  }
  if (maybeExpansion === undefined) {
    return false;
  }
  if (maybeExpansion.forms.some((form) => seen === (exact ? form : form.toLowerCase()))) {
    return true;
  }
  for (const rawStem of maybeExpansion.stems) {
    const stem = exact ? rawStem : rawStem.toLowerCase();
    if (seen.startsWith(stem)) {
      const rest = seen.slice(stem.length);
      if (!rest || (isAlpha(rest) && (!exact || rest === rest.toLowerCase()))) {
        return true;
      }
    }
  }
  return false;
}

/** Where an entry's term was found. `wording` is the text as written there, which may differ from the title;
 * `start` and `end` are offsets into the text in UTF-16 units. */
export interface Match {
  readonly entryId: string;
  readonly start: number;
  readonly end: number;
  readonly wording: string;
}

// Only a key's last word matches by its expansion: in English it is a phrase's head that inflects, usually the last
// word ("hydra taxes"), and Finnish puts its ending on the last word of an English phrase; inflecting an earlier word
// is a misfire ("prose" in "Prose basilisks" catching "prosentti").
function expansionFor(key: readonly string[], index: number, expansions: ReadonlyMap<string, Expansion>): Expansion | undefined {
  return index === key.length - 1 ? expansions.get(key[index]!) : undefined;
}

/** Whether the words of `window` are the words of `key`, in any order: paired one to one, each pair accepted. */
function windowMatches(key: readonly string[], window: readonly string[], expansions: ReadonlyMap<string, Expansion>): boolean {
  // A key is a few words long, so trying every pairing costs less than anything cleverer would to write.
  for (const order of permutations(window)) {
    if (key.every((keyWord, index) => accepts(keyWord, order[index]!, expansionFor(key, index, expansions)))) {
      return true;
    }
  }
  return false;
}

/** Which entries' terms appear in `text`: entry id -> the last place one does. As Python's `find_matches`, which
 * gives the rules: whole words, a term's words in any order, smart case. */
export function findMatches(
  entries: ReadonlyMap<string, Entry>,
  text: string,
  { expansions = new Map() }: { expansions?: ReadonlyMap<string, Expansion> } = {},
): Map<string, Match> {
  const normalized = normalize(text);
  const whole = words(normalized);
  // A word joined from parts by a hyphen or an apostrophe is also read as its parts, so that "hydra-taxed" and
  // "Bordeaux'n" fire the terms their parts are, and a possessive fires with no form listed. A term with a hyphen
  // of its own ("co-pter") still matches the word whole, in the first reading.
  const split = whole.flatMap(parts);
  const same = split.length === whole.length && split.every((unit, i) => unit[0] === whole[i]![0] && unit[1] === whole[i]![1]);
  const readings = same ? [whole] : [whole, split];
  const distinct = new Set(readings.flatMap((units) => units.map(([word]) => word)));

  const found = new Map<string, Match>();
  for (const entry of entries.values()) {
    let best: [number, number] | null = null; // [start, end] in the text, of the last match
    for (const key of keysOf(entry)) {
      // Which of the text's words each key word accepts, worked out once for both readings. Only the last word may
      // match by its expansion.
      const last = key[key.length - 1]!;
      const accepted = new Map<string, Set<string>>();
      for (const keyWord of key) {
        if (!accepted.has(keyWord)) {
          const expansion = keyWord === last ? expansions.get(keyWord) : undefined;
          accepted.set(keyWord, new Set([...distinct].filter((word) => accepts(keyWord, word, expansion))));
        }
      }
      for (const units of readings) {
        const maybeSpan = lastMatch(key, units, accepted, expansions);
        if (maybeSpan !== null && (best === null || maybeSpan[0] > best[0])) {
          best = maybeSpan;
        }
      }
    }
    if (best !== null) {
      const [start, end] = best;
      found.set(entry.id, { entryId: entry.id, start, end, wording: normalized.slice(start, end) });
    }
  }
  return found;
}

/** A word as its parts, where a hyphen or an apostrophe joins them; the word itself, when it has one part. */
function parts(unit: Unit): Unit[] {
  const [word, start] = unit;
  const found = [...word.matchAll(WORD_PART)].map((m) => [m[0], start + m.index, start + m.index + m[0].length] as const);
  return found.length > 1 ? found : [unit];
}

/** Where in the text the last run of `units` matching `key` is, as `[start, end]`; `null` if none does. */
function lastMatch(
  key: readonly string[],
  units: readonly Unit[],
  accepted: ReadonlyMap<string, ReadonlySet<string>>,
  expansions: ReadonlyMap<string, Expansion>,
): [number, number] | null {
  const n = key.length;
  const textWords = units.map(([word]) => word);
  // Every window holding the key holds a word for each key word, so only the windows around the occurrences of the
  // key word with the fewest are worth looking at.
  let rarest: ReadonlySet<string> | null = null;
  for (const set of accepted.values()) {
    if (rarest === null || set.size < rarest.size) {
      rarest = set;
    }
  }
  let best: number | null = null; // first word of the last match
  textWords.forEach((word, position) => {
    if (!rarest!.has(word)) {
      return;
    }
    for (let first = Math.max(0, position - n + 1); first <= Math.min(position, units.length - n); first++) {
      if ((best === null || first > best) && windowMatches(key, textWords.slice(first, first + n), expansions)) {
        best = first;
      }
    }
  });
  if (best === null) {
    return null;
  }
  return [units[best]![1], units[best + n - 1]![2]];
}

// ----------------------------------------
// Choosing what fires

/** An entry chosen to be given to the model. As Python's `Firing`, which see. */
export interface Firing {
  readonly entry: Entry;
  readonly depth: number;
  readonly maybeWording: string | null;
  readonly maybeVia: string | null;
  readonly tokens: number;
}

/** Choose which entries fire for `text`, and the entries they lead to. As Python's `select`, which gives the rules:
 * depth 0 for the terms in `text`, then through links, or the terms in an entry's content; shallower first, then in
 * `order`; an entry that does not fit the budget skipped. */
export function select(
  entries: ReadonlyMap<string, Entry>,
  text: string,
  {
    countTokens,
    budget,
    maxDepth,
    alreadyFired = [],
    expansions = new Map(),
  }: {
    countTokens: (text: string) => number;
    budget: number;
    maxDepth: number;
    alreadyFired?: Iterable<string>;
    expansions?: ReadonlyMap<string, Expansion>;
  },
): Firing[] {
  const anchors = new Map<string, string>();
  for (const entry of entries.values()) {
    for (const anchor of entry.anchors) {
      anchors.set(anchor, entry.id);
    }
  }
  const visited = new Set(alreadyFired);
  const chosen: Firing[] = [];
  let remaining = budget;

  const take = (candidates: Firing[]): Firing[] => {
    const taken: Firing[] = [];
    for (const firing of [...candidates].sort((x, y) => x.entry.order - y.entry.order)) {
      const cost = countTokens(formatEntry(firing.entry));
      if (cost > remaining) {
        continue; // fired, but does not fit the budget
      }
      remaining -= cost;
      taken.push({ ...firing, tokens: cost });
    }
    return taken;
  };

  const matches = findMatches(entries, text, { expansions });
  let level = take([...matches].filter(([id]) => !visited.has(id))
    .map(([id, match]) => ({ entry: entries.get(id)!, depth: 0, maybeWording: match.wording, maybeVia: null, tokens: 0 })));
  for (const id of matches.keys()) {
    visited.add(id); // fired or skipped, either way not again at another depth
  }
  for (let depth = 1; depth <= maxDepth && level.length > 0; depth++) {
    chosen.push(...level);
    const candidates = new Map<string, Firing>();
    for (const { entry } of level) {
      const targets = entry.crossrefs.length > 0
        ? entry.crossrefs.filter((anchor) => anchors.has(anchor)).map((anchor) => anchors.get(anchor)!)
        : [...findMatches(entries, entry.content, { expansions }).keys()];
      for (const target of targets) {
        if (!visited.has(target) && !candidates.has(target)) {
          candidates.set(target, { entry: entries.get(target)!, depth, maybeWording: null, maybeVia: entry.id, tokens: 0 });
        }
      }
    }
    for (const id of candidates.keys()) {
      visited.add(id);
    }
    level = take([...candidates.values()]);
  }
  // The last level taken; empty when the loop ended for want of one.
  chosen.push(...level);
  return chosen;
}

// ----------------------------------------
// Looking a term up

export const CANONICAL_NOT_DEFINED =
  "The term '{term}' is not defined in the lorebook. It holds only the terms the user has defined, so most words are not in it.";
export const CANONICAL_NEAR_MISS = "There is no entry for '{term}'. The closest is '{title}':";
export const CANONICAL_NO_ENTRY = "There is no entry for '{term}'.";
export const CANONICAL_CANDIDATES = "The closest entries are: {titles}.";
export const CANONICAL_MENTIONED_IN = "It is mentioned in: {titles}.";
export const CANONICAL_LOOK_ONE_UP = "Look one of them up by its title.";

// How alike a term and a title must be (`SequenceMatcher.ratio`) to count as a near miss. Read off the glossary this
// was built against: a one-letter typo of any of its titles scores 0.857 or more (median 0.966), while the terms a
// model tried when searching it by meaning scored 0.667 or less against their nearest title. Difflib's own default,
// 0.6, sits among the latter, and took "introspection" for "Miroconnection".
const NEAR_MISS_CUTOFF = 0.8;
const MAX_TITLES = 5; // titles offered at most, in one list of candidates or of mentions

/** The answer to looking up a term. As Python's `Lookup`, which see. */
export interface Lookup {
  readonly maybeEntry: Entry | null;
  readonly exact: boolean;
  readonly candidates: readonly string[];
  readonly mentionedIn: readonly string[];
}

/** Find the entry for `term`, as a model asking for it by name would want. As Python's `lookup`, which gives the
 * rules: exact in any order and any case, then one near miss taken as meant, then the near misses and the entries
 * mentioning the term. */
export function lookup(
  entries: ReadonlyMap<string, Entry>,
  term: string,
  { expansions = new Map() }: { expansions?: ReadonlyMap<string, Expansion> } = {},
): Lookup {
  const wanted = keyOf(term, { sentenceCase: false });
  // The term's words, and the same with a hyphenated or apostrophized word in parts, as `findMatches` reads.
  const split = wanted.flatMap((word) => parts([word, 0, word.length]).map(([part]) => part));
  const readings = split.length === wanted.length && split.every((part, i) => part === wanted[i]) ? [wanted] : [wanted, split];
  const spellings = new Map<string, string>(); // a key as written, lowercased -> the entry it belongs to
  for (const entry of entries.values()) {
    for (const key of keysOf(entry)) {
      const matches = (candidate: readonly string[]): boolean => {
        if (key.length !== candidate.length) {
          return false;
        }
        for (const order of permutations(candidate)) {
          if (key.every((keyWord, index) => accepts(keyWord, order[index]!, expansionFor(key, index, expansions), true))) {
            return true;
          }
        }
        return false;
      };
      if (readings.some(matches)) {
        return { maybeEntry: entry, exact: true, candidates: [], mentionedIn: [] };
      }
    }
    for (const phrase of [entry.title, ...entry.aliases]) {
      const spelling = normalize(phrase).toLowerCase();
      if (!spellings.has(spelling)) {
        spellings.set(spelling, entry.id);
      }
    }
  }
  const close = getCloseMatches(normalize(term).toLowerCase(), [...spellings.keys()], MAX_TITLES, NEAR_MISS_CUTOFF);
  const ids = unique(close.map((spelling) => spellings.get(spelling)!)); // several spellings, one entry
  if (ids.length === 1) {
    return { maybeEntry: entries.get(ids[0]!)!, exact: false, candidates: [], mentionedIn: [] };
  }
  // The term as a key of its own, in lowercase so that it matches in any case, run over each entry's content.
  const probe = new Map<string, Entry>([["probe", {
    id: "probe", title: normalize(term).toLowerCase(), aliases: [], content: "", crossrefs: [], anchors: [], source: "", order: 0,
  }]]);
  const mentionedIn = [...entries.values()].filter((entry) => findMatches(probe, entry.content).size > 0)
    .map((entry) => entry.title).slice(0, MAX_TITLES);
  return { maybeEntry: null, exact: false, candidates: ids.map((id) => entries.get(id)!.title), mentionedIn };
}

/** An entry as the model reads it: its title, then its content. */
export function formatEntry(entry: Entry): string {
  return `${entry.title}\n\n${entry.content}`;
}

/** The text the `lorebook_lookup` tool answers `term` with. */
export function answer(
  entries: ReadonlyMap<string, Entry>,
  term: string,
  { expansions = new Map() }: { expansions?: ReadonlyMap<string, Expansion> } = {},
): string {
  const found = lookup(entries, term, { expansions });
  if (found.maybeEntry !== null) {
    if (found.exact) {
      return formatEntry(found.maybeEntry);
    }
    return `${format(CANONICAL_NEAR_MISS, { term, title: found.maybeEntry.title })}\n\n${formatEntry(found.maybeEntry)}`;
  }
  if (found.candidates.length === 0 && found.mentionedIn.length === 0) {
    return format(CANONICAL_NOT_DEFINED, { term });
  }
  const quoted = (titles: readonly string[]): string => titles.map((title) => `'${title}'`).join(", ");
  const sentences = [format(CANONICAL_NO_ENTRY, { term })];
  if (found.candidates.length > 0) {
    sentences.push(format(CANONICAL_CANDIDATES, { titles: quoted(found.candidates) }));
  }
  if (found.mentionedIn.length > 0) {
    sentences.push(format(CANONICAL_MENTIONED_IN, { titles: quoted(found.mentionedIn) }));
  }
  sentences.push(CANONICAL_LOOK_ONE_UP);
  return sentences.join(" ");
}

export const TOOL_NAME = "lorebook_lookup";

/** The lookup tool as the model is shown it: an OpenAI-style function specification. */
export function toolSpec(): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: TOOL_NAME,
      description: "Look up a term in the lorebook: the user's own definitions of terms, mostly their coinages and the special senses they give to ordinary words. Only the terms the user has defined are in it, so most words are not. Definitions of terms that come up in the conversation are given to you as they come up; look up one you need that has not been given.",
      parameters: {
        type: "object",
        properties: { term: { type: "string", description: "The term to look up, as it was written." } },
        required: ["term"],
        additionalProperties: false,
      },
    },
  };
}
