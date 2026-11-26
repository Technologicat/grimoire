// grimoire's pi settings: an optional `~/.pi/agent/grimoire.json`, every key defaulting to Raven's own folders.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DIRECTORY } from "../ts/core/src/ledger.ts";

export const SETTINGS_FILE = join(homedir(), ".pi", "agent", "grimoire.json");

export interface Settings {
  /** The lorebook folder: Markdown files, each entry a section whose header is the term. */
  readonly lorebookDir: string;
  /** Where the terms' inflected forms are read from: Raven's expansion ledgers, or grimoire-expand's. */
  readonly ledgerDir: string;
  /** Languages whose stems are used as well as their whole-word forms. */
  readonly stemLanguages: readonly string[];
  /** The most characters of definitions given with one message. */
  readonly budget: number;
}

export const DEFAULTS: Settings = {
  lorebookDir: join(homedir(), ".config", "raven", "librarian", "lorebook"),
  ledgerDir: DEFAULT_DIRECTORY,
  stemLanguages: [],
  budget: 8_000,
};

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path;
}

/** The settings in `path`, over the defaults; the defaults alone when the file is missing. A key of the wrong type
 * is reported in `problems` and left at its default; an unreadable file is a problem as a whole. */
export function readSettings(path: string = SETTINGS_FILE): { settings: Settings; problems: string[] } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { settings: DEFAULTS, problems: missing ? [] : [`${path}: ${(error as Error).message}`] };
  }
  let given: unknown;
  try {
    given = JSON.parse(raw);
  } catch (error) {
    return { settings: DEFAULTS, problems: [`${path}: ${(error as Error).message}`] };
  }
  if (typeof given !== "object" || given === null || Array.isArray(given)) {
    return { settings: DEFAULTS, problems: [`${path}: expected an object of settings`] };
  }
  const values = given as Record<string, unknown>;
  const problems: string[] = [];
  const pick = <T>(key: keyof Settings, ok: (value: unknown) => value is T, fallback: T): T => {
    if (!(key in values)) {
      return fallback;
    }
    if (ok(values[key])) {
      return values[key];
    }
    problems.push(`${path}: '${key}' has the wrong type; using the default`);
    return fallback;
  };
  const isString = (value: unknown): value is string => typeof value === "string" && value !== "";
  const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string");
  const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;
  for (const key of Object.keys(values)) {
    if (!(key in DEFAULTS)) {
      problems.push(`${path}: unknown setting '${key}', ignored`);
    }
  }
  return {
    settings: {
      lorebookDir: expandHome(pick("lorebookDir", isString, DEFAULTS.lorebookDir)),
      ledgerDir: expandHome(pick("ledgerDir", isString, DEFAULTS.ledgerDir)),
      stemLanguages: pick("stemLanguages", isStrings, DEFAULTS.stemLanguages),
      budget: pick("budget", isCount, DEFAULTS.budget),
    },
    problems,
  };
}
