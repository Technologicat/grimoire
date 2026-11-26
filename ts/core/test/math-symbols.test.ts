// The TypeScript core's table of math symbols against the Python core's, read out of `core/lorebookcore.py`.

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { MATH_SYMBOLS } from "../src/lorebookcore.ts";

/** The Python core's `_MATH_SYMBOLS`, as the string Python makes of the literal: escapes decoded. */
function pythonTable(): string {
  const source = readFileSync(new URL("../../../core/lorebookcore.py", import.meta.url), "utf-8");
  const literal = /^_MATH_SYMBOLS = \(([\s\S]*?)\)$/m.exec(source);
  expect(literal, "no `_MATH_SYMBOLS = (...)` in the Python core").not.toBeNull();
  const joined = [...literal![1]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join("");
  return joined.replace(/\\U([0-9a-fA-F]{8})|\\u([0-9a-fA-F]{4})/g, (_, long: string, short: string) =>
    String.fromCodePoint(parseInt(long ?? short, 16)));
}

test("the table is the Python core's", () => {
  const python = new RegExp(`[${pythonTable()}]`, "u");
  const ours = new RegExp(`[${MATH_SYMBOLS}]`, "u");
  expect(python.test("∇") && !python.test("+"), "the Python table did not read as meant, so this compares nothing").toBe(true);
  const differ: string[] = [];
  for (let c = 0x80; c <= 0x10ffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue; // surrogates are not characters
    const ch = String.fromCodePoint(c);
    if (python.test(ch) !== ours.test(ch)) differ.push(`U+${c.toString(16).toUpperCase().padStart(4, "0")}`);
  }
  expect(differ).toEqual([]);
});
