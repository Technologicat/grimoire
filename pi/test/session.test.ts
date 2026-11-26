// The extension in a real pi session, run through pi's SDK. What this checks that the unit tests cannot:
//   - Against a scripted model, which records what it is sent: that what the `context` event returns reaches the
//     model, that nothing of it is stored, and that the lookup tool is registered and runs. The scripted model gets
//     the messages before a provider's own conversion, so it says nothing about that.
//   - Against a fake OpenAI-compatible server, as gufo and LM Studio are reached: that the round survives pi's
//     conversion for that wire format, and what the server is sent.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { type AssistantMessage, fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryModelsStore, type Message } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { grimoire } from "../index.ts";

const GLOSSARY = "## Hydra tax\nClosing one item opens two.\n\n## Fup\nNot a typo.\n";
let folder: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "grimoire-pi-session-"));
  mkdirSync(join(folder, "lorebook"));
  writeFileSync(join(folder, "lorebook", "glossary.md"), GLOSSARY, "utf-8");
  writeFileSync(join(folder, "grimoire.json"), JSON.stringify({
    lorebookDir: join(folder, "lorebook"), ledgerDir: join(folder, "no-ledgers"),
  }), "utf-8");
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

/** A session with the extension and nothing else of the user's, against a scripted model; `sent` collects the
 * messages of each request the model gets. */
async function session(steps: ((messages: Message[]) => AssistantMessage)[]) {
  const runtime = await ModelRuntime.create({ modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false });
  const faux = fauxProvider({ models: [{ id: "scripted", contextWindow: 50_000, maxTokens: 1000, input: ["text"] }] });
  runtime.registerNativeProvider(faux.provider);
  await runtime.refresh({ allowNetwork: false });
  const model = runtime.getModel(faux.provider.id, "scripted")!;
  const sent: Message[][] = [];
  faux.setResponses(steps.map((step) => (context) => {
    sent.push(structuredClone(context.messages));
    return { ...step(context.messages), api: model.api, provider: model.provider, model: model.id };
  }));
  const resourceLoader = new DefaultResourceLoader({
    cwd: folder, agentDir: folder, extensionFactories: [grimoire(join(folder, "grimoire.json"))],
  });
  await resourceLoader.reload();
  const created = await createAgentSession({
    cwd: folder, agentDir: folder, modelRuntime: runtime, model, resourceLoader, sessionManager: SessionManager.inMemory(folder),
  });
  return { session: created.session, sent };
}

/** The messages as the model got them, in order, each as its role and a short description. */
function shape(messages: Message[]): string[] {
  return messages.map((m) => {
    if (m.role === "assistant") {
      return `assistant: ${m.content.map((part) => (part.type === "toolCall" ? `call ${part.name}(${JSON.stringify(part.arguments)}) ${part.id}` : part.type)).join(", ")}`;
    }
    if (m.role === "toolResult") {
      return `result ${m.toolCallId}: ${m.content.map((part) => (part.type === "text" ? part.text : part.type)).join("")}`;
    }
    return `${m.role}: ${typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : p.type)).join("")}`;
  });
}

test("the model gets the definitions as a tool round before the prompt, and nothing is stored", async () => {
  const { session: s, sent } = await session([() => fauxAssistantMessage("Yes.")]);
  try {
    await s.prompt("Is this a hydra tax?");
    expect(shape(sent[0]!).slice(-3)).toEqual([
      'assistant: call lorebook_lookup({"term":"Hydra tax"}) grimoire-lorebook-0',
      "result grimoire-lorebook-0: Hydra tax\n\nClosing one item opens two.",
      "user: Is this a hydra tax?",
    ]);
    const stored = JSON.stringify(s.messages);
    expect(stored).toContain("Is this a hydra tax?");
    expect(stored, "the round went into the session").not.toContain("grimoire-lorebook-");
  } finally {
    s.dispose();
  }
});

test("the model's own lookup runs, and the round is given once on each call of the tool loop", async () => {
  const { session: s, sent } = await session([
    () => fauxAssistantMessage([fauxToolCall("lorebook_lookup", { term: "fup" }, { id: "call_1" })], { stopReason: "toolUse" }),
    () => fauxAssistantMessage("Done."),
  ]);
  try {
    await s.prompt("Is this a hydra tax? And look up fup.");
    expect(sent).toHaveLength(2);
    const second = shape(sent[1]!);
    expect(second.filter((line) => line.includes("grimoire-lorebook-0")).length, "the round was not given exactly once").toBe(2);
    expect(second.slice(-2)).toEqual([
      'assistant: call lorebook_lookup({"term":"fup"}) call_1',
      "result call_1: Fup\n\nNot a typo.",
    ]);
  } finally {
    s.dispose();
  }
});

/** An OpenAI-compatible server answering every chat completion with one streamed word; `bodies` collects the
 * requests' bodies. */
async function fakeServer(): Promise<{ server: Server; url: string; bodies: Record<string, unknown>[] }> {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      bodies.push(JSON.parse(raw));
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "m",
          choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(chunk({ role: "assistant", content: "Yes." }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, bodies };
}

test("an OpenAI-compatible server is sent the round as tool calls answered before the prompt", async () => {
  const { server, url, bodies } = await fakeServer();
  try {
    writeFileSync(join(folder, "models.json"), JSON.stringify({ providers: { fake: {
      baseUrl: url, api: "openai-completions", apiKey: "none",
      models: [{ id: "m", input: ["text"], contextWindow: 50_000, reasoning: false }],
    } } }), "utf-8");
    const runtime = await ModelRuntime.create({ modelsStore: new InMemoryModelsStore(), modelsPath: join(folder, "models.json"), allowModelNetwork: false });
    const model = runtime.getModel("fake", "m");
    expect(model, "the fake provider's model is not in the runtime, so nothing below is reached").toBeDefined();
    const resourceLoader = new DefaultResourceLoader({ cwd: folder, agentDir: folder, extensionFactories: [grimoire(join(folder, "grimoire.json"))] });
    await resourceLoader.reload();
    const { session: s } = await createAgentSession({
      cwd: folder, agentDir: folder, modelRuntime: runtime, model: model!, resourceLoader, sessionManager: SessionManager.inMemory(folder),
    });
    try {
      await s.prompt("Is this a hydra tax?");
    } finally {
      s.dispose();
    }
    expect(bodies).toHaveLength(1);
    const messages = (bodies[0]!.messages as { role: string; content?: unknown; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }[]);
    const last = messages.slice(-3);
    expect(last.map((m) => m.role)).toEqual(["assistant", "tool", "user"]);
    expect(last[0]!.tool_calls!.map((c) => [c.function.name, JSON.parse(c.function.arguments)])).toEqual([["lorebook_lookup", { term: "Hydra tax" }]]);
    expect(last[1]!.tool_call_id).toBe(last[0]!.tool_calls![0]!.id);
    expect(JSON.stringify(last[1]!.content)).toContain("Closing one item opens two.");
    expect(JSON.stringify(last[2]!.content)).toContain("Is this a hydra tax?");
    expect((bodies[0]!.tools as { function: { name: string } }[]).map((t) => t.function.name)).toContain("lorebook_lookup");
  } finally {
    server.close();
  }
});
