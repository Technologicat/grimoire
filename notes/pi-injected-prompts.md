# What pi sends a model beyond what its TUI shows

**Pinned to pi 1.6.1** (`@earendil-works/pi-coding-agent` and its sibling packages, all 1.6.1), read in the shipped
`dist` JavaScript on 2026-11-27. File paths are relative to `node_modules/@earendil-works/`; line numbers are those of
1.6.1 and will move. Read for one question, and verified in the source except where marked *inference*.

## Why

With pi talking to local Qwen models over an OpenAI-compatible API, two things were seen in pi and in no other
frontend: Qwen3.8 Flash Next replied that the user had sent only system instructions, and Qwen3.8 27B hallucinated
user inputs. The suspicion was that pi sends the model text its TUI does not show.

## Findings

**In a default setup — no extensions, no skill or template commands — nothing was found that empties the user's
turn or replaces it with instructions.** The user's text goes out as the `user` message, and the system prompt as
one leading `system` message. User-role text the TUI does not show comes from extensions, `/skill:` and template
commands, `!` shell runs and compaction.

### The system prompt

Built in `pi-coding-agent/dist/core/system-prompt.js` (`buildSystemPromptSections`, line 68; `buildSystemPrompt`,
line 131). In order, each section after the first wrapped in `<name>…</name>`:

- a preamble ("You are a coding assistant running inside pi, a coding agent harness. …"); a custom system prompt
  replaces it and drops the next three sections
- `<tools>`: a line per tool (the JSON schemas go in the request's `tools` field)
- `<rules>`: bullets such as "Be concise in your responses"
- `<docs>`: about ten lines of paths to pi's documentation
- `<addendum>`: the user's appended system prompt
- `<project_context>`: AGENTS.md-style files, each as `<project_instructions path=…>`
- `<skills>`: the available skills' names, descriptions and paths
- `<cwd>`, then any sections extensions define

No date. Roughly 2–3 KB before context files and skills (*inference*), growing with them.

### Custom messages become user messages

`convertToLlm` (`pi-coding-agent/dist/core/messages.js`, lines 83–131) maps every role of pi's own to `role: "user"`:

- `bashExecution`, a `!cmd` run: "Ran `cmd`" and its output (not for `!!cmd`)
- `custom`, a message from an extension: its content as is. With `display: false` the TUI does not render it, and
  it is still sent.
- `compactionSummary`: "The conversation history before this point was compacted into the following summary:"
  and the summary in `<summary>` tags; `branchSummary` likewise

### Where they come from

In `pi-coding-agent/dist/core/agent-session.js`:

- **A run's messages** (`_prepareRun`, around line 1549): the user's message, then queued next-turn messages, then
  messages extensions add in `before_agent_start`, as `custom`. So the model can see two user-role messages in a
  row, the last of them the extension's.
- **Image hints** are appended to the user's own text (around line 1576).
- **`/skill:name args`** (`_expandSkillCommand`, lines 1820–1834) replaces the user's text with
  `<skill name=… location=…>`, the skill's whole `SKILL.md`, `</skill>`, and then the args. Without args, the user's
  turn is nothing but that instruction block. Prompt templates (`/name`) are expanded into the user's text too.
- **An extension's `context` handler** (`transformContext`, `sdk.js`, line 277) can rewrite the whole list before
  it is sent. grimoire's pi extension is one: it inserts a lookup round, an assistant tool call and its result,
  before the last user message.

### On the wire (chat completions)

`convertMessages`, in `pi-ai/dist/api/openai-completions.js` (lines 874–1139):

- **System messages** are collapsed into one leading message, later ones removed, since the default compatibility
  setting `supportsMidConvoSystemMessages` is false (`utils/transcript.js`, lines 96–104). The role is `system`;
  `developer` only for api.openai.com.
- **User messages** go out as they are. Empty text parts are dropped, and a user message left with no parts is
  skipped altogether (around line 960), so a turn of only empty parts can leave the model seeing system, then
  assistant, with no user turn between. Consecutive user messages are not merged.
- **Thinking** goes back as an assistant field, `reasoning_content` for llama.cpp (lines 1011–1017), never as user
  text, unless the compatibility setting `requiresThinkingAsText` is set.
- **Tool results** go as `role: "tool"`, "(no tool output)" when empty. Images in a tool result become an extra
  user message, "Attached image(s) from tool result:" (around line 1120).

## What could produce the symptoms

- A `/skill:` command without args: the user's turn is entirely harness instructions — "only system instructions".
- An extension's `custom` or `before_agent_start` message after the user's: the last user-role message the model
  sees is harness text.
- After compaction, the first user message is the injected summary.
- A user message of only empty parts, dropped: no user turn at all.
- *Inference:* llama.cpp's chat template rendering the replayed `reasoning_content`, or a long system prompt,
  badly.

**Checked against the setup it was seen in** (the work machine's pi, 2026-11-27; the behaviour predates
grimoire's extension):

- **`pi-tps`** (the `feat/exchange-stats` branch of the maintainer's fork) stores its telemetry with
  `pi.appendEntry`, which makes a session entry of type `custom`. `sessionEntryToContextMessages`
  (`pi-coding-agent/dist/core/session-manager.js`, line 166) passes on only messages, `custom_message` entries
  (what `sendMessage` makes), branch summaries and compactions; a `custom` entry becomes nothing. So it never reaches
  the model.
- **A local `date.ts`** sets a system prompt section, `current_date`, in `before_agent_start`: system text, folded
  into the leading `system` message.

Neither adds user-role text. That leaves skill and template commands, compaction, and the chat template.

**Seen right after a tool call** (maintainer's observation): the model says the user wrote "(no content)", or
that the user gave no instructions and the system prompt asks it to always continue after a tool call. Neither
phrase is in pi 1.6.1: "(no content)" occurs only in the TUI's session tree, an empty tool result goes out as
"(no tool output)", and pi's rules say nothing about continuing; nor are they in `pi-tps`, `date.ts` or the
agent's `AGENTS.md`. **Qwen3.8's chat template** (read from the 27B's GGUF, unsloth's Q4_K_XL) **renders a tool
result as a user turn**: `<|im_start|>user`, then the output in `<tool_response>` tags. So after a tool call the
model's latest "user message" is the tool's output, and an empty or terse one reads as the user saying nothing.
Where the two phrases come from is still open: the model's own wording, or the serving stack's template (Flash
Next's was not read).

**Open:** which of these was in play when the behaviour was seen — which extensions were installed (grimoire's
included), and whether a skill command or compaction preceded it. The way to settle it is to capture a request
body: pi's `onPayload` hook (`sdk.js`, line 274) exposes it, or llama.cpp's server can log it.
