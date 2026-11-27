// The definitions for the terms near the end of a conversation, put into the user's message, before its text,
// between markers: what grimoire's LM Studio plugin does to each message. LM Studio's prompt preprocessor can only
// replace the user's message, and what it returns is kept in the chat, so each definition is given once per chat,
// and what was given is read back from the history, between the same markers.
//
// Written against plain text and roles, and nothing of LM Studio's, so that it can be tested without the SDK.

import { type Entry, type Expansion, formatEntry, select } from "./core/lorebookcore.ts";
import { len } from "./core/pystr.ts";

// Raven's scan and depth. Characters rather than tokens, as the conformance cases count them.
export const SCANNED_MESSAGES = 5; // the user's message and the four before it
export const MAX_DEPTH = 2;

export const BLOCK_START = "[Lorebook: the user's definitions of terms in this message]";
export const BLOCK_END = "[End of lorebook definitions]";
export const SEPARATOR = "\n\n---\n\n";
// Before a definition edited since this chat was given it, so that the model knows why it comes again.
export const CHANGED_NOTE = "(Changed on disk since it was given earlier in this conversation.)\n\n";

/** A message of the history: its role, and its text. */
export interface Message {
  readonly role: string;
  readonly text: string;
}

const BLOCK = new RegExp(`${escape(BLOCK_START)}\\n\\n([\\s\\S]*?)\\n\\n${escape(BLOCK_END)}\\n\\n`, "g");

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `text` with the definitions blocks this plugin put into it taken out. */
export function withoutDefinitions(text: string): string {
  return text.replace(BLOCK, "");
}

/** The definitions blocks in the history's user messages, as the text between the markers, and the characters
 * they take, markers included. */
export function blocksIn(history: readonly Message[]): { blocks: string[]; spent: number } {
  const blocks: string[] = [];
  let spent = 0;
  for (const message of history) {
    if (message.role === "user") {
      for (const block of message.text.matchAll(BLOCK)) {
        blocks.push(block[1]!);
        spent += len(block[0]);
      }
    }
  }
  return { blocks, spent };
}

/** Whether `entry` was given in one of `blocks` as it is now, given with other text since edited, or not given. */
// Asked of each entry rather than read off the blocks, which a definition holding a line of its own like the
// separator would split wrongly.
export function givenAs(entry: Entry, blocks: readonly string[]): "unchanged" | "changed" | "not given" {
  const text = formatEntry(entry);
  if (blocks.some((block) => block.includes(text))) {
    return "unchanged";
  }
  // A definition starts a block, or follows a separator, perhaps after the note.
  const start = `${entry.title}\n\n`;
  const begins = (at: string) => at.startsWith(start) || at.startsWith(CHANGED_NOTE + start);
  const given = blocks.some((block) => begins(block) || block.split(SEPARATOR).slice(1).some(begins));
  return given ? "changed" : "not given";
}

/** The user's message with the definitions for the terms near the end of the conversation put before its text, and
 * the entries given; the message without any earlier definitions, and none, when there is nothing to give.
 *
 * `history`: the messages before this one. Scans this message and the user and assistant messages before it,
 * `SCANNED_MESSAGES` in all, with the definitions blocks taken out, so a definition fires nothing.
 * `budget`: the most characters of definitions in this message. `cap`: the most in the whole chat.
 */
export function withDefinitions(
  text: string,
  history: readonly Message[],
  entries: ReadonlyMap<string, Entry>,
  expansions: ReadonlyMap<string, Expansion>,
  { budget, cap }: { budget: number; cap: number },
): { text: string; given: Entry[] } {
  // A message rewritten before, if LM Studio runs this on it again, is rewritten afresh rather than twice.
  const original = withoutDefinitions(text);
  const { blocks, spent } = blocksIn(history);
  const unchanged = new Set<string>();
  const changed = new Set<string>();
  for (const entry of entries.values()) {
    const state = givenAs(entry, blocks);
    if (state !== "not given") {
      (state === "unchanged" ? unchanged : changed).add(entry.id);
    }
  }
  const room = Math.min(budget, cap - spent - len(BLOCK_START) - len(BLOCK_END) - 4);
  if (room <= 0) {
    return { text: original, given: [] };
  }
  const conversation = [...history.filter((m) => m.role === "user" || m.role === "assistant"), { role: "user", text: original }];
  const scanned = conversation.slice(-SCANNED_MESSAGES).map((m) => withoutDefinitions(m.text)).join("\n\n");
  const changedTexts = new Set([...changed].map((id) => formatEntry(entries.get(id)!)));
  // Each definition is counted with the separator around it, and the note where it gets one, so the block stays
  // within the budget however many there are.
  const size = (definition: string): number =>
    len(definition) + len(SEPARATOR) + (changedTexts.has(definition) ? len(CHANGED_NOTE) : 0);
  const firings = select(entries, scanned, { countTokens: size, budget: room, maxDepth: MAX_DEPTH, alreadyFired: unchanged, expansions });
  if (firings.length === 0) {
    return { text: original, given: [] };
  }
  const definitions = firings
    .map(({ entry }) => (changed.has(entry.id) ? CHANGED_NOTE : "") + formatEntry(entry))
    .join(SEPARATOR);
  return { text: `${BLOCK_START}\n\n${definitions}\n\n${BLOCK_END}\n\n${original}`, given: firings.map((f) => f.entry) };
}
