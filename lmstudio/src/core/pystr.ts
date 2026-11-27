// Python's string semantics, where JavaScript's differ, for the translation of Raven's `lorebookcore.py`.
//
// The core is specified by its Python original and its conformance cases, so where the two languages disagree
// about strings, this module sides with Python. Each export names the Python it stands for.

/** The characters of Python's `\w` on a `str`: those `str.isalnum()` accepts, and `_`. As a regex fragment.
 *
 * JavaScript's own `\w` is ASCII-only, even under the `u` flag. Python's `isalnum()` is `isalpha()` (the letter
 * categories, `\p{L}`) or any of `isdecimal`/`isdigit`/`isnumeric` (the number categories, `\p{N}`). Use it in a
 * pattern with the `u` flag.
 */
export const W = String.raw`[\p{L}\p{N}_]`;

/** The characters Python's `str.isspace()` accepts, which its `\s`, `str.strip()` and `str.split()` use. As a
 * regex fragment.
 *
 * JavaScript's `\s` and `trim()` differ on a handful: they take U+FEFF, the byte order mark, which Python does not,
 * and leave out U+001C to U+001F and U+0085, which Python takes.
 */
export const S = String.raw`[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]`;

/** `W` and `S` without their brackets, to combine into a class of their own, or negate: `[^${W_CHARS}-]`. */
export const W_CHARS = W.slice(1, -1);
export const S_CHARS = S.slice(1, -1);

const leading = new RegExp(`^${S}+`, "u");
const trailing = new RegExp(`${S}+$`, "u");

/** Python's `str.strip()`. */
export function strip(text: string): string {
  return text.replace(leading, "").replace(trailing, "");
}

// Python's `str.splitlines()` breaks at each of these, with `\r\n` as one break.
const lineBreak = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/u;

/** Python's `str.splitlines()`: the lines without their breaks, and no empty last line after a final break. */
export function splitlines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const lines = text.split(lineBreak);
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** Python's `str.isalpha()`: not empty, and every character a letter. */
export function isAlpha(text: string): boolean {
  return /^\p{L}+$/u.test(text);
}

/** The code points of `text`, as Python indexes a `str`. A JavaScript string indexes UTF-16 units, which differ
 * past the Basic Multilingual Plane, where one code point is two units. */
export function codePoints(text: string): string[] {
  return Array.from(text);
}

/** Python's `len()` of a `str`: its code points. */
export function len(text: string): number {
  let count = 0;
  for (const _ of text) {
    count++;
  }
  return count;
}

/** How Python orders two strings: code point by code point. For `Array.prototype.sort`.
 *
 * JavaScript's default comparison goes by UTF-16 unit, and the two disagree whenever a code point past U+FFFF,
 * written as a surrogate pair from U+D800, meets one from U+E000 to U+FFFF.
 */
export function compareCodePoints(a: string, b: string): number {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const x = left.next();
    const y = right.next();
    if (x.done || y.done) {
      return x.done === y.done ? 0 : x.done ? -1 : 1;
    }
    const difference = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
    if (difference !== 0) {
      return difference;
    }
  }
}

/** The length, in code points, of the longest common prefix of `a` and `b`: Python's
 * `len(os.path.commonprefix([a, b]))`, which compares strings character by character. */
export function commonPrefixLength(a: string, b: string): number {
  const left = codePoints(a);
  const right = codePoints(b);
  let n = 0;
  while (n < left.length && n < right.length && left[n] === right[n]) {
    n++;
  }
  return n;
}

/** Python's `itertools.permutations(items)`, in its order: lexicographic by position. */
export function* permutations<T>(items: readonly T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield [...items];
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) {
      yield [items[i]!, ...tail];
    }
  }
}

/** Python's `str.format` for the `{name}` fields the core's canonical sentences use. */
export function format(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (field, name: string) => values[name] ?? field);
}
