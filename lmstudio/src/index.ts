// grimoire's LM Studio plugin: the definitions of the user's terms as they come up, and the lookup tool.
//
// Its prompt preprocessor puts the definitions for the terms in the user's message and the four messages before it
// into that message, before its text (see `definitions.ts`); LM Studio keeps the rewritten message in the chat, so
// each definition is given once per chat. Its tools provider offers `lorebook_lookup`.

import { homedir } from "node:os";
import { join } from "node:path";
import { createConfigSchematics, type PluginContext, rawFunctionTool, type PromptPreprocessorController, type ChatMessage, type ToolsProviderController } from "@lmstudio/sdk";
import { DEFAULT_DIRECTORY, loadExpansions } from "./core/ledger.ts";
import { answer, load, TOOL_NAME, toolSpec } from "./core/lorebookcore.ts";
import { type Message, withDefinitions } from "./definitions.ts";

const DEFAULT_LOREBOOK = join(homedir(), ".config", "raven", "librarian", "lorebook");

// Per chat: whether the lorebook is on in it.
export const chatConfig = createConfigSchematics()
  .field("enabled", "boolean", {
    displayName: "Lorebook",
    subtitle: "Give the model the definitions of your terms as they come up in this chat.",
  }, true)
  .build();

// For all chats: where the lorebook is, and how much of it to give.
export const globalConfig = createConfigSchematics()
  .field("lorebookDir", "string", {
    displayName: "Lorebook folder",
    subtitle: "Markdown files, each entry a section whose header is the term. Empty for Raven's folder.",
    placeholder: DEFAULT_LOREBOOK,
  }, "")
  .field("ledgerDir", "string", {
    displayName: "Inflected forms folder",
    subtitle: "Raven's expansion ledgers, or grimoire-expand's. Empty for Raven's folder.",
    placeholder: DEFAULT_DIRECTORY,
  }, "")
  .field("stemLanguages", "stringArray", {
    displayName: "Languages matched by stem",
    subtitle: "Languages that inflect too much to list every form, such as Finnish.",
  }, [])
  .field("budget", "numeric", {
    int: true, min: 1_000, displayName: "Characters per message",
    subtitle: "The most characters of definitions given with one message.",
  }, 8_000)
  .field("cap", "numeric", {
    int: true, min: 1_000, displayName: "Characters per chat",
    subtitle: "The most characters of definitions given in one chat.",
  }, 64_000)
  .build();

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path;
}

/** The lorebook and its terms' forms, as the global settings name them. */
function readLorebook(ctl: PromptPreprocessorController | ToolsProviderController) {
  const config = ctl.getGlobalPluginConfig(globalConfig);
  const [entries] = load(expandHome(config.get("lorebookDir").trim() || DEFAULT_LOREBOOK));
  const expansions = loadExpansions(expandHome(config.get("ledgerDir").trim() || DEFAULT_DIRECTORY), entries, {
    stemLanguages: config.get("stemLanguages"),
  });
  return { config, entries, expansions };
}

async function preprocess(ctl: PromptPreprocessorController, userMessage: ChatMessage): Promise<string | ChatMessage> {
  if (!ctl.getPluginConfig(chatConfig).get("enabled")) {
    return userMessage;
  }
  try {
    const { config, entries, expansions } = readLorebook(ctl);
    if (entries.size === 0) {
      return userMessage;
    }
    const history: Message[] = (await ctl.pullHistory()).getMessagesArray()
      .map((message) => ({ role: message.getRole(), text: message.getText() }));
    const { text, given } = withDefinitions(userMessage.getText(), history, entries, expansions, {
      budget: config.get("budget"), cap: config.get("cap"),
    });
    if (given.length === 0) {
      return userMessage;
    }
    ctl.createStatus({ status: "done", text: `Lorebook: ${given.map((entry) => entry.title).join(", ")}` });
    return text;
  } catch (error) {
    // The message goes to the model without definitions rather than not at all.
    ctl.createStatus({ status: "error", text: `Lorebook: ${(error as Error).message}` });
    return userMessage;
  }
}

async function provideTools(_ctl: ToolsProviderController) {
  const spec = toolSpec().function as { description: string; parameters: unknown };
  return [
    rawFunctionTool({
      name: TOOL_NAME,
      description: spec.description,
      parametersJsonSchema: spec.parameters,
      implementation: async (params) => {
        const { entries, expansions } = readLorebook(_ctl);
        if (entries.size === 0) {
          return "The lorebook is empty or not found. Its folder is set in grimoire's plugin settings.";
        }
        return answer(entries, String(params.term ?? ""), { expansions });
      },
    }),
  ];
}

export async function main(context: PluginContext): Promise<void> {
  context.withConfigSchematics(chatConfig);
  context.withGlobalConfigSchematics(globalConfig);
  context.withPromptPreprocessor(preprocess);
  context.withToolsProvider(provideTools);
}
