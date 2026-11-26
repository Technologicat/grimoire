// The pi extension's insertion of definitions, against pi's message shapes, without pi.

import { describe, expect, test } from "vitest";
import { type Entry, parse } from "../../ts/core/src/lorebookcore.ts";
import { CALL_ID_PREFIX, type Message, withDefinitions } from "../definitions.ts";

const GLOSSARY = `## Hydra tax
Closing one item opens two. Paid as [attention rent](#attention-rent).

## Attention rent
What an open item costs.

## Fup
Not a typo.
`;
const entries: Map<string, Entry> = new Map(parse(GLOSSARY, { name: "glossary" }).map((e) => [e.id, e]));
const MODEL = { api: "openai-completions", provider: "gufo", id: "flash-next" };

const user = (content: unknown, timestamp = 1): Message => ({ role: "user", content, timestamp });
const reply = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });
const USER = user("Is this a hydra tax?");

function insert(messages: Message[], budget = 8_000) {
  return withDefinitions(messages, entries, new Map(), { budget, model: MODEL });
}

/** The terms of the definitions inserted, from the round's calls. */
function given(messages: readonly Message[]): string[] {
  return messages.flatMap((m) => (m.role === "assistant" && Array.isArray(m.content) ? m.content : []))
    .filter((part) => typeof part.id === "string" && part.id.startsWith(CALL_ID_PREFIX))
    .map((part) => part.arguments.term);
}

describe("withDefinitions", () => {
  test("the definitions go before the user's message, as a tool round from the model being called", () => {
    const { messages } = insert([USER]);
    expect(messages.at(-1)).toBe(USER);
    const [call, ...answers] = messages.slice(0, -1);
    expect(call).toMatchObject({ role: "assistant", stopReason: "toolUse", api: "openai-completions", provider: "gufo", model: "flash-next" });
    const calls = call!.content as { id: string; name: string }[];
    expect(calls.map((c) => c.name)).toEqual(["lorebook_lookup", "lorebook_lookup"]);
    expect(answers.map((a) => a.toolCallId)).toEqual(calls.map((c) => c.id));
    expect(answers.map((a) => a.role)).toEqual(["toolResult", "toolResult"]);
    expect((answers[1]!.content as { text: string }[])[0]!.text).toBe("Attention rent\n\nWhat an open item costs.");
  });

  test("with nothing to give, the messages come back as they were", () => {
    const messages = [user("Nothing to see here.")];
    const result = insert(messages);
    expect(result.messages).toBe(messages);
    expect(result.given).toEqual([]);
  });

  test("running again changes nothing", () => {
    const once = insert([USER]).messages;
    expect(once.length, "nothing was inserted, so this fixture cannot show a second run adds nothing").toBeGreaterThan(1);
    expect(insert([...once]).messages).toEqual(once);
  });

  test("on a later call of a tool loop, the round goes before the user's message, the loop after it kept", () => {
    const ownCall: Message = { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }], stopReason: "toolUse" };
    const ownResult: Message = { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "hydra tax" }], isError: false };
    const { messages } = insert([USER, ownCall, ownResult]);
    expect(messages.slice(-3)).toEqual([USER, ownCall, ownResult]);
    expect(given(messages)).toEqual(["Hydra tax", "Attention rent"]);
  });

  test("the scan reaches the four messages before the user's", () => {
    const earlier = reply("Paying the fup again.");
    const filler = [user("And?"), reply("So.")];
    // Fourth before the user's message, so the last of the five scanned; then fifth, and out.
    expect(given(insert([earlier, ...filler, filler[0]!, USER]).messages)).toContain("Fup");
    expect(given(insert([earlier, ...filler, ...filler, USER]).messages)).not.toContain("Fup");
  });

  test("tool results, thinking and pi's own messages fire nothing", () => {
    const quiet = user("Hello.");
    const thinking: Message = { role: "assistant", content: [{ type: "thinking", thinking: "a hydra tax" }], stopReason: "stop" };
    const result: Message = { role: "toolResult", toolCallId: "x", toolName: "read", content: [{ type: "text", text: "hydra tax" }], isError: false };
    const custom: Message = { role: "custom", customType: "date", content: "about the hydra tax", display: false };
    for (const noise of [thinking, result, custom]) {
      expect(given(insert([noise, quiet]).messages)).toEqual([]);
    }
  });

  test("content given as parts is read", () => {
    expect(given(insert([user([{ type: "text", text: "A hydra tax?" }, { type: "image", data: "", mimeType: "image/png" }])]).messages))
      .toEqual(["Hydra tax", "Attention rent"]);
  });

  test("the budget holds", () => {
    // The hydra tax's entry, 81 characters, fits; the one it links to, 40, does not.
    expect(given(insert([USER], 100).messages)).toEqual(["Hydra tax"]);
  });

  test("a conversation without a user message is left alone", () => {
    const messages = [reply("A hydra tax.")];
    expect(insert(messages).messages).toBe(messages);
  });
});
