// The TypeScript `difflib` against what Python's own `difflib` computes, from `difflib_cases.json`, which
// `scripts/make_difflib_cases.py` writes.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { getCloseMatches, SequenceMatcher } from "../src/difflib.ts";

interface Pair {
  a: string;
  b: string;
  junk: string | null;
  autojunk: boolean;
  ratio: number;
  quick_ratio: number;
  real_quick_ratio: number;
  blocks: [number, number, number][];
}
interface Close {
  word: string;
  possibilities: string[];
  n: number;
  cutoff: number;
  expect: string[];
}
const cases: { pairs: Pair[]; close: Close[] } = JSON.parse(
  readFileSync(new URL("difflib_cases.json", import.meta.url), "utf-8"),
);

describe("SequenceMatcher", () => {
  test.each(cases.pairs.map((pair) => [`${JSON.stringify(pair.a).slice(0, 30)} ~ ${JSON.stringify(pair.b).slice(0, 30)}`, pair]))(
    "%s",
    (_, pair) => {
      const isjunk = pair.junk === null ? null : (element: string) => pair.junk!.includes(element);
      const matcher = new SequenceMatcher(isjunk, pair.a, pair.b, pair.autojunk);
      expect(matcher.getMatchingBlocks()).toEqual(pair.blocks);
      expect(matcher.ratio()).toBe(pair.ratio);
      expect(matcher.quickRatio()).toBe(pair.quick_ratio);
      expect(matcher.realQuickRatio()).toBe(pair.real_quick_ratio);
    },
  );

  test("the cases reach the autojunk heuristic, on and off, and junk", () => {
    // A second sequence of 200 or more code points is where the heuristic applies; without one, it is untested.
    const long = cases.pairs.filter((pair) => Array.from(pair.b).length >= 200);
    expect(long.some((pair) => pair.autojunk)).toBe(true);
    expect(long.some((pair) => !pair.autojunk)).toBe(true);
    expect(cases.pairs.some((pair) => pair.junk !== null)).toBe(true);
  });
});

describe("getCloseMatches", () => {
  test.each(cases.close.map((close) => [close.word, close]))("%s", (_, close) => {
    expect(getCloseMatches(close.word, close.possibilities, close.n, close.cutoff)).toEqual(close.expect);
  });
});
