// grimoire's pi extension: the definitions of the user's terms as they come up, and the lookup tool.
//
// Before every call to the model, the definitions for the terms in the last user message and the four messages
// before it go into what the model is sent, as a round of `lorebook_lookup` calls answered by the entries, just
// before that message. Nothing is stored in the session: the round is made afresh for each call, from the
// conversation as it stands. Settings: `~/.pi/agent/grimoire.json`, optional (see `settings.ts`).

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { loadExpansions } from "../ts/core/src/ledger.ts";
import { answer, type Entry, load, TOOL_NAME, toolSpec } from "../ts/core/src/lorebookcore.ts";
import { type Message, withDefinitions } from "./definitions.ts";
import { readSettings, SETTINGS_FILE, type Settings } from "./settings.ts";

/** The lorebook the settings name, with its terms' forms; problems with the settings or the folder in `problems`. */
function readLorebook(settingsFile: string): { settings: Settings; entries: Map<string, Entry>; expansions: ReturnType<typeof loadExpansions>; problems: string[] } {
  const { settings, problems } = readSettings(settingsFile);
  const [entries, folderProblems] = load(settings.lorebookDir);
  for (const [filename, problem] of folderProblems) {
    problems.push(`${filename}: ${problem}`);
  }
  const expansions = loadExpansions(settings.ledgerDir, entries, { stemLanguages: settings.stemLanguages });
  return { settings, entries, expansions, problems };
}

/** The extension, reading its settings from `settingsFile`. */
export function grimoire(settingsFile: string = SETTINGS_FILE): (pi: ExtensionAPI) => void {
  return (pi) => install(pi, settingsFile);
}

export default grimoire();

function install(pi: ExtensionAPI, settingsFile: string): void {
  // What the last call to the model was given, for the footer and `/lorebook`.
  let lastGiven: Entry[] = [];
  let lastProblems: string[] = [];

  const showStatus = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) {
      return;
    }
    const n = lastGiven.length;
    const status = lastProblems.length > 0 ? "lorebook: see /lorebook" : `lorebook: ${n} ${n === 1 ? "definition" : "definitions"}`; // plural
    ctx.ui.setStatus("lorebook", status);
  };

  pi.on("context", (event, ctx) => {
    try {
      const { settings, entries, expansions, problems } = readLorebook(settingsFile);
      lastProblems = problems;
      const model = ctx.model;
      if (entries.size === 0 || model === undefined) {
        lastGiven = [];
        return;
      }
      const result = withDefinitions(event.messages as unknown as Message[], entries, expansions, {
        budget: settings.budget,
        model: { api: model.api, provider: model.provider, id: model.id },
      });
      lastGiven = result.given;
      return result.given.length > 0 ? { messages: result.messages as unknown as typeof event.messages } : undefined;
    } catch (error) {
      // The model is called without definitions rather than not at all.
      lastGiven = [];
      lastProblems = [`${(error as Error).name}: ${(error as Error).message}`];
      return undefined;
    } finally {
      showStatus(ctx);
    }
  });

  const spec = toolSpec().function as { description: string; parameters: unknown };
  pi.registerTool({
    name: TOOL_NAME,
    label: "Lorebook lookup",
    description: spec.description,
    promptSnippet: "Look up a term in the user's lorebook, their definitions of their own terms",
    // The core's own JSON Schema; pi takes JSON Schema as well as TypeBox.
    parameters: spec.parameters as TSchema,
    async execute(_toolCallId, params) {
      const { entries, expansions } = readLorebook(settingsFile);
      const term = String((params as { term?: unknown }).term ?? "");
      const text = entries.size > 0
        ? answer(entries, term, { expansions })
        : `The lorebook is empty or not found. Its folder is set in ${settingsFile}, as "lorebookDir".`;
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  pi.registerCommand("lorebook", {
    description: "Show which lorebook definitions the model was last given",
    handler: async (_args, ctx) => {
      const { settings } = readSettings(settingsFile);
      const lines = [
        lastGiven.length > 0 ? `Given with the last call: ${lastGiven.map((entry) => entry.title).join(", ")}` : "No definitions given with the last call.",
        `Lorebook: ${settings.lorebookDir}`,
        `Inflected forms: ${settings.ledgerDir}`,
        ...lastProblems,
      ];
      if (ctx.hasUI) {
        ctx.ui.notify(lines.join("\n"), lastProblems.length > 0 ? "warning" : "info");
      }
    },
  });
}
