// The LM Studio plugin's rewriting of the user's message, without LM Studio.

import { describe, expect, test } from "vitest";
import { type Entry, parse } from "../src/core/lorebookcore.ts";
import { BLOCK_END, BLOCK_START, CHANGED_NOTE, type Message, withDefinitions, withoutDefinitions } from "../src/definitions.ts";

const GLOSSARY = `## Hydra tax
Closing one item opens two. Paid as [attention rent](#attention-rent).

## Attention rent
What an open item costs.

## Fup
Part one.

---

Part two.
`;
const entriesOf = (glossary: string): Map<string, Entry> => new Map(parse(glossary, { name: "glossary" }).map((e) => [e.id, e]));
const entries = entriesOf(GLOSSARY);
const LIMITS = { budget: 8_000, cap: 64_000 };

function rewrite(text: string, history: Message[] = [], theEntries = entries, limits = LIMITS) {
  return withDefinitions(text, history, theEntries, new Map(), limits);
}

const titles = (given: Entry[]): string[] => given.map((entry) => entry.title);

describe("withDefinitions", () => {
  test("the definitions go before the user's text, between the markers, with what they link to", () => {
    const { text, given } = rewrite("Is this a hydra tax?");
    expect(titles(given)).toEqual(["Hydra tax", "Attention rent"]);
    expect(text.startsWith(`${BLOCK_START}\n\nHydra tax\n\nClosing one item opens two.`)).toBe(true);
    expect(text.endsWith(`${BLOCK_END}\n\nIs this a hydra tax?`)).toBe(true);
  });

  test("with nothing to give, the message comes back as it was", () => {
    expect(rewrite("Nothing to see here.")).toEqual({ text: "Nothing to see here.", given: [] });
  });

  test("a definition given earlier in the chat is not given again", () => {
    const first = rewrite("A hydra tax?");
    const history = [{ role: "user", text: first.text }, { role: "assistant", text: "Yes." }];
    expect(rewrite("Another hydra tax?", history).given).toEqual([]);
  });

  test("an edited definition is given again, with a note, and what it links to is not", () => {
    const history = [{ role: "user", text: rewrite("A hydra tax?").text }, { role: "assistant", text: "Yes." }];
    const edited = entriesOf(GLOSSARY.replace("opens two", "opens three"));
    expect(rewrite("Another hydra tax?", history, entries).given, "an unchanged definition was given again, so this "
      + "fixture cannot tell an edit from a repeat").toEqual([]);
    const { text, given } = rewrite("Another hydra tax?", history, edited);
    expect(titles(given)).toEqual(["Hydra tax"]);
    expect(text).toContain(`${CHANGED_NOTE}Hydra tax\n\nClosing one item opens three.`);
  });

  test("a definition holding a line like the separator is still recognized as given", () => {
    const first = rewrite("What is a fup?");
    expect(first.text, "the definition has no separator in it, so this fixture tests nothing").toContain("Part one.\n\n---\n\nPart two.");
    const history = [{ role: "user", text: first.text }, { role: "assistant", text: "A thing." }];
    expect(rewrite("And a fup again?", history).given).toEqual([]);
  });

  test("a message rewritten before is rewritten afresh, not twice", () => {
    const once = rewrite("Is this a hydra tax?").text;
    expect(rewrite(once).text).toBe(once);
    expect(withoutDefinitions(once)).toBe("Is this a hydra tax?");
  });

  test("the scan reaches the four messages before, and definitions given there fire nothing", () => {
    const earlier: Message = { role: "assistant", text: "Paying the fup again." };
    const filler: Message[] = [{ role: "user", text: "And?" }, { role: "assistant", text: "So." }];
    // Fourth before this message, so the last of the five scanned; then fifth, and out.
    expect(titles(rewrite("Go on.", [earlier, ...filler, filler[0]!]).given)).toContain("Fup");
    expect(titles(rewrite("Go on.", [earlier, ...filler, ...filler]).given)).not.toContain("Fup");
    // A block whose definition mentions "attention rent", given without that entry: the mention fires nothing.
    const block = `${BLOCK_START}\n\nHydra tax\n\nClosing one item opens two. Paid as [attention rent](#attention-rent).\n\n${BLOCK_END}\n\nHm.`;
    expect(rewrite("Go on.", [{ role: "user", text: block }]).given).toEqual([]);
  });

  test("the budget holds per message, and the cap over the chat", () => {
    // The hydra tax's definition, 81 characters, fits in 100; the one it links to, 40, does not.
    expect(titles(rewrite("A hydra tax?", [], entries, { budget: 100, cap: 64_000 }).given)).toEqual(["Hydra tax"]);
    const spentAlready = [{ role: "user", text: `${BLOCK_START}\n\n${"x".repeat(1_000)}\n\n${BLOCK_END}\n\nHm.` }];
    expect(rewrite("A hydra tax?", spentAlready, entries, { budget: 8_000, cap: 1_100 }).given).toEqual([]);
    expect(rewrite("A hydra tax?", spentAlready, entries, { budget: 8_000, cap: 64_000 }).given,
      "nothing was given with room to spare, so this fixture cannot show the cap stopping it").not.toEqual([]);
  });
});
