// The definitions for the terms near the end of a conversation, as a `lorebook_lookup` tool round inserted before
// its last user message: what grimoire's pi extension does to the messages before each call to the model.
//
// Written against the shapes of pi's messages, and nothing of pi's own, so that it can be tested without pi.

import { type Entry, type Expansion, formatEntry, select, TOOL_NAME } from "../ts/core/src/lorebookcore.ts";
import { len } from "../ts/core/src/pystr.ts";

// Raven's scan and depth. Characters rather than tokens, as the conformance cases count them.
export const SCANNED_MESSAGES = 5; // the last user message and the four before it
export const MAX_DEPTH = 2;
export const CALL_ID_PREFIX = "grimoire-lorebook-";

/** A message as pi passes it to the `context` event: its role, and whatever else that role carries. */
export type Message = { role: string; [field: string]: unknown };

/** The model the round is attributed to, which should be the one about to be called: pi treats an assistant message
 * from another model as foreign, and rewrites it. */
export interface ModelIdentity {
  readonly api: string;
  readonly provider: string;
  readonly id: string;
}

/** A message's text: its content if a string, else its text parts; thinking and tool calls left out. */
function textOf(message: Message): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

/** The entries as a round of `lorebook_lookup` calls and their answers, as if the model had looked them up. */
export function definitionsRound(entries: readonly Entry[], model: ModelIdentity, timestamp: number): Message[] {
  const calls = entries.map((entry, n) => ({
    type: "toolCall", id: `${CALL_ID_PREFIX}${n}`, name: TOOL_NAME, arguments: { term: entry.title },
  }));
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const call: Message = {
    role: "assistant",
    content: calls,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
    // "toolUse", as a real round ends: pi drops an assistant message that stopped on "error" or "aborted".
    stopReason: "toolUse",
    timestamp,
  };
  const answers: Message[] = entries.map((entry, n) => ({
    role: "toolResult",
    toolCallId: calls[n]!.id,
    toolName: TOOL_NAME,
    content: [{ type: "text", text: formatEntry(entry) }],
    isError: false,
    timestamp,
  }));
  return [call, ...answers];
}

/** `messages` with the definitions for the terms near its end inserted before its last user message, and the
 * entries given; `messages` itself, and none, when there is nothing to give or its definitions are already there.
 *
 * Scans the last user message and the user and assistant messages before it, `SCANNED_MESSAGES` in all; tool results
 * and pi's other messages are left out, so neither an earlier definition nor a tool's output fires anything.
 */
export function withDefinitions(
  messages: readonly Message[],
  entries: ReadonlyMap<string, Entry>,
  expansions: ReadonlyMap<string, Expansion>,
  { budget, model }: { budget: number; model: ModelIdentity },
): { messages: readonly Message[]; given: Entry[] } {
  const ours = (message: Message): boolean => message.role === "assistant" && Array.isArray(message.content) &&
    message.content.some((part) => typeof part?.id === "string" && part.id.startsWith(CALL_ID_PREFIX));
  if (messages.some(ours)) {
    return { messages, given: [] };
  }
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  if (lastUser === -1) {
    return { messages, given: [] };
  }
  const conversation = messages.slice(0, lastUser + 1).filter((m) => m.role === "user" || m.role === "assistant");
  const text = conversation.slice(-SCANNED_MESSAGES).map(textOf).join("\n\n");
  const firings = select(entries, text, { countTokens: len, budget, maxDepth: MAX_DEPTH, expansions });
  if (firings.length === 0) {
    return { messages, given: [] };
  }
  const given = firings.map((firing) => firing.entry);
  const timestamp = typeof messages[lastUser]!.timestamp === "number" ? (messages[lastUser]!.timestamp as number) : Date.now();
  return {
    messages: [...messages.slice(0, lastUser), ...definitionsRound(given, model, timestamp), ...messages.slice(lastUser)],
    given,
  };
}
