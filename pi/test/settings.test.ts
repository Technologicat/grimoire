// The pi extension's settings file.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DEFAULTS, readSettings } from "../settings.ts";

let folder: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "grimoire-pi-settings-"));
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

function settingsFrom(text: string) {
  const path = join(folder, "grimoire.json");
  writeFileSync(path, text, "utf-8");
  return readSettings(path);
}

test("without a file, the defaults are Raven's folders", () => {
  const { settings, problems } = readSettings(join(folder, "missing.json"));
  expect(settings).toEqual(DEFAULTS);
  expect(settings.lorebookDir).toBe(join(homedir(), ".config", "raven", "librarian", "lorebook"));
  expect(problems).toEqual([]);
});

test("the file's values replace the defaults, a leading ~ expanded", () => {
  const { settings, problems } = settingsFrom(JSON.stringify({ lorebookDir: "~/glossaries", stemLanguages: ["Finnish"], budget: 4000 }));
  expect(settings).toEqual({ ...DEFAULTS, lorebookDir: join(homedir(), "glossaries"), stemLanguages: ["Finnish"], budget: 4000 });
  expect(problems).toEqual([]);
});

test("a value of the wrong type, or an unknown key, is reported and left out", () => {
  const { settings, problems } = settingsFrom(JSON.stringify({ budget: "lots", stemLanguages: "Finnish", lorebookDri: "/x" }));
  expect(settings).toEqual(DEFAULTS);
  expect(problems).toHaveLength(3);
});

test("a file that does not parse is reported, and the defaults used", () => {
  const { settings, problems } = settingsFrom("{ lorebookDir: nope");
  expect(settings).toEqual(DEFAULTS);
  expect(problems).toHaveLength(1);
});
