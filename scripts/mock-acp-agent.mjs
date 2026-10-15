#!/usr/bin/env node
// A stand-in ACP agent for the Rust tests in src-tauri/src/agent, so CI needs
// no agent installed, no account and no network. It speaks the wire shapes in
// docs/acp-transcript.md, which were recorded from real agents - when an
// adapter is bumped and those change, this changes with them.
//
//   node scripts/mock-acp-agent.mjs [--flavor codex|claude|opencode]
//
// The flavours differ the way the real agents do:
//
//   codex     a "read-only" mode, which it must be put in before it will
//             answer; models under `models.availableModels`, starting on one
//             the account does not offer; errors as "Internal error" with the
//             reason under `data.details`
//   claude    no "read-only" mode ("Invalid Mode"); asks before every change
//             in its "default" mode, and refuses to answer in a mode that
//             does not; models as a `configOptions` entry; extra
//             notifications nuza has no use for
//   opencode  no modes at all; a line on stdout that is not JSON-RPC
//   reckless  modes, none of which asks before changing anything
//
// What a prompt does is scripted by words in it:
//
//   (anything)      streams "You said: <text>" a word at a time
//   SHOW_PROMPT     streams the whole prompt text back, untouched
//   SHOW_MODEL      "model <id>"           SHOW_MCP   "mcp <the mcpServers>"
//   WHICH_MODE      "mode <id>"
//   SHOW_CWD        "cwd <path> <how many entries it has>"
//   SHOW_PID        "pid <the mock's process id>"
//   RICH            a thought, a step and its update, a plan and usage first
//   NOISE           unknown notifications and a non-JSON line mid-turn
//   SLOW            200 words, 20ms apart, so a test can cancel part way
//   STALL           says nothing, and answers only when cancelled
//   CRASH           prints its reasons on stderr and exits
//   REFUSAL         ends the turn with stopReason "refusal"
//   USAGE_LIMIT     fails the prompt with a plan-limit error
//   PERMISSION      asks to write a file first, and reports what it was told
//   ASK_FS          asks the client to read a file, and reports the answer
//   FETCHCALL       asks to fetch a web page        RUNCALL  asks to run one
//   MCPCALL         calls a tool on the "nuza" MCP server, then asks for it
//   OTHERCALL       the same for a server that is not nuza's
//   SNEAKYCALL      a shell command titled like one of nuza's tools
//   REJECT_MODEL    the model that replaced the start one is turned down too
//   REJECT_ALL      every model is turned down
//   PROPOSE         proposes edits to the first two sentences of the note it
//                   was sent, in a nuza-edits block
//   PROPOSE_BADLY   the same, but with an anchor that is not in the note -
//                   which it fixes when asked again ("could not be applied")

import fs from "node:fs";
import readline from "node:readline";

const flavor = process.argv.includes("--flavor")
  ? process.argv[process.argv.indexOf("--flavor") + 1]
  : "codex";

const MODES = {
  codex: { current: "auto", available: ["read-only", "auto", "full-access"] },
  claude: { current: "default", available: ["default", "acceptEdits", "plan", "auto", "bypassPermissions"] },
  opencode: null,
  reckless: { current: "auto", available: ["auto", "bypassPermissions"] },
};
// A session in one of these does not ask before it changes something, so the
// mock will not answer in it: a test that forgets to lock a session down
// fails rather than passing on an agent that could have written a file.
const UNSAFE_MODES = new Set(["auto", "full-access", "acceptEdits", "plan", "bypassPermissions"]);

const sessions = new Map(); // sessionId -> { mode, model, mcpServers }
let sessionCounter = 0;
let requestCounter = 0;
const waitingOnClient = new Map();
const cancelled = new Set();
const stalled = new Map(); // sessionId -> the prompt request left unanswered

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const respond = (id, result) => send({ jsonrpc: "2.0", id, result });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const update = (sessionId, body) => notify("session/update", { sessionId, update: body });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(id, reason, code = -32603) {
  // Codex and the Claude adapter both hide the reason under "Internal error".
  const error =
    flavor === "opencode"
      ? { code, message: reason }
      : { code: -32603, message: "Internal error", data: { details: reason } };
  send({ jsonrpc: "2.0", id, error });
}

function askClient(method, params) {
  // Real agents number their own requests from 0.
  const id = requestCounter++;
  return new Promise((resolve) => {
    waitingOnClient.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

const OFFERED = flavor === "codex" ? ["current[low]", "backup[low]"] : ["sonnet", "haiku"];

function modelsOf(session) {
  if (flavor === "codex") {
    return {
      models: {
        currentModelId: session.model,
        availableModels: OFFERED.map((modelId) => ({ modelId, name: modelId, description: "" })),
      },
    };
  }
  const options = [
    ...(MODES[flavor]
      ? [
          {
            id: "mode",
            category: "mode",
            type: "select",
            currentValue: session.mode,
            options: MODES[flavor].available.map((value) => ({ value, name: value })),
          },
        ]
      : []),
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: session.model,
      options: OFFERED.map((value) => ({ value, name: value[0].toUpperCase() + value.slice(1) })),
    },
  ];
  return { configOptions: options };
}

function modesOf(session) {
  if (!MODES[flavor]) return {};
  return {
    modes: {
      currentModeId: session.mode,
      availableModes: MODES[flavor].available.map((id) => ({ id, name: id })),
    },
  };
}

async function permissionFor(sessionId, toolCall) {
  const answer = await askClient("session/request_permission", {
    sessionId,
    toolCall,
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  });
  const outcome = answer?.result?.outcome;
  return `${outcome?.outcome}/${outcome?.optionId ?? "-"}`;
}

/** The note in a prompt, as nuza wraps it, if there is one. */
function noteIn(text) {
  const match = /<note id="([^"]+)">\n([\s\S]*?)\n<\/note id="\1">/.exec(text);
  return match ? match[2] : null;
}

/**
 * What the stand-in says about a note: its title, its sections, and what was
 * selected in it. It reads the note's shape, not its meaning - and says so.
 */
function answerAbout(note) {
  if (!note)
    return "There's no note text to go on here. Open a note, or turn on sending the whole note, and ask again.";
  const selected = /⟦selection⟧([\s\S]*?)⟦\/selection⟧/.exec(note)?.[1]?.trim();
  const lines = note.replace(/⟦\/?selection⟧/g, "").split("\n");
  const title =
    lines.find((line) => /^#\s/.test(line))?.replace(/^#\s+/, "") ??
    lines.find((line) => /^title:\s*/.test(line))?.replace(/^title:\s*/, "") ??
    "This note";
  const sections = lines.filter((line) => /^##\s/.test(line)).map((line) => line.replace(/^##\s+/, ""));
  const parts = [
    sections.length
      ? `**${title}** has ${sections.length} section${sections.length === 1 ? "" : "s"}: ${sections.join(", ")}.`
      : `**${title}** is a single section.`,
  ];
  if (selected) parts.push(`The part you selected reads:\n\n> ${selected.split("\n").join("\n> ")}`);
  parts.push(
    "_I'm nuza's stand-in agent, so I can describe a note's shape but not understand it. Ask with PROPOSE to try suggested edits._"
  );
  return parts.join("\n\n");
}

/** Edits to the first two plain sentences of a note: what a real agent might suggest. */
function editsFor(note) {
  let inFrontmatter = note.startsWith("---");
  const sentences = [];
  for (const [index, line] of note.split("\n").entries()) {
    if (inFrontmatter) {
      if (index > 0 && line.trim() === "---") inFrontmatter = false;
      continue;
    }
    const plain = line.trim();
    if (!plain || plain.startsWith("#") || plain.startsWith("-") || plain.includes("⟦")) continue;
    sentences.push(plain);
  }
  return sentences.slice(0, 2).map((find) => ({
    find,
    replace: find.replace(/\.$/, "") + ", put more plainly.",
    why: "A mock edit, to try the review out.",
  }));
}

const editsBlock = (edits) => "```nuza-edits\n" + JSON.stringify(edits, null, 2) + "\n```";

async function prompt(id, { sessionId, prompt: parts }) {
  const session = sessions.get(sessionId);
  if (!session) return fail(id, "Session not found");
  if (UNSAFE_MODES.has(session.mode)) return fail(id, `refusing to run in mode ${session.mode}`);

  const text = (parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  // A question from the app, wrapped in nuza's framing, gets an answer the way
  // an agent would give one. A bare test message is echoed, so the Rust tests
  // can see exactly what arrived.
  const asked = /(?:Their question|The change they want[^:\n]*):\n([\s\S]*)$/.exec(text);
  let reply = asked ? answerAbout(noteIn(text) ?? session.note ?? null) : `You said: ${text}`;

  if (text.includes("STALL")) return void stalled.set(sessionId, id);

  // The note a session was last sent, for an edit asked for again.
  const note = noteIn(text);
  if (note !== null) session.note = note;
  if (text.includes("PROPOSE") && session.note) {
    const edits = editsFor(session.note);
    if (text.includes("PROPOSE_BADLY"))
      edits[0] = { ...edits[0], find: "A sentence that is not in the note." };
    reply = `Here are ${edits.length} changes.\n\n${editsBlock(edits)}`;
  } else if (text.includes("could not be applied") && session.note) {
    reply = `Fixed.\n\n${editsBlock(editsFor(session.note).slice(0, 1))}`;
  }

  if (text.includes("CRASH")) {
    process.stderr.write("npm error code EACCES\nnpm error path /Users/me/.npm/_cacache\n");
    setTimeout(() => process.exit(1), 10);
    return;
  }

  if (text.includes("NOISE")) {
    process.stdout.write("[plugin] loading something\n");
    notify("_auth/status_update", { authStatus: { kind: "account", label: "Pro" } });
    update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [] });
    update(sessionId, { sessionUpdate: "session_info_update", title: "A chat" });
  }

  if (text.includes("RICH")) {
    update(sessionId, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Let me look." },
    });
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Read releases.md",
      kind: "read",
      status: "pending",
    });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
    update(sessionId, {
      sessionUpdate: "plan",
      entries: [{ content: "Answer", priority: "high", status: "in_progress" }],
    });
    update(sessionId, { sessionUpdate: "usage_update", used: 1200, size: 200000 });
  }

  if (text.includes("PERMISSION")) {
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "w1",
      title: "Write hello.txt",
      kind: "edit",
      status: "pending",
    });
    reply = `permission outcome: ${await permissionFor(sessionId, { toolCallId: "w1", title: "Write hello.txt", kind: "edit" })}`;
  }

  if (text.includes("FETCHCALL") || text.includes("RUNCALL")) {
    const kind = text.includes("FETCHCALL") ? "fetch" : "execute";
    const title = kind === "fetch" ? "Fetch https://example.com" : "Run ls";
    reply = `call outcome: ${await permissionFor(sessionId, { toolCallId: "c2", title, kind })}`;
  }

  if (text.includes("MCPCALL") || text.includes("OTHERCALL")) {
    const server = text.includes("MCPCALL") ? "nuza" : "other";
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: `mcp.${server}.search_vault`,
      kind: "other",
      status: "pending",
      rawInput: { server, tool: "search_vault", arguments: {} },
    });
    reply = `call outcome: ${await permissionFor(sessionId, { toolCallId: "c1", kind: "other" })}`;
  }

  if (text.includes("SNEAKYCALL")) {
    // What an adapter that titles a command with the command itself would
    // send, for a command that happens to look like a call to nuza.
    const call = { toolCallId: "s1", title: "mcp__nuza__search_vault", kind: "execute", status: "pending" };
    update(sessionId, {
      sessionUpdate: "tool_call",
      ...call,
      rawInput: { command: "mcp__nuza__search_vault" },
    });
    reply = `call outcome: ${await permissionFor(sessionId, call)}`;
  }

  if (text.includes("ASK_FS")) {
    const answer = await askClient("fs/read_text_file", { sessionId, path: "/etc/hosts" });
    reply = `fs answer: ${answer?.error?.code ?? "allowed"}`;
  }

  if (text.includes("USAGE_LIMIT")) return fail(id, "You've hit your usage limit. Try again in 3 hours.");

  // A plan that does not cover every model: the one a Codex session starts on
  // is always turned down, and REJECT_MODEL / REJECT_ALL turn more down.
  const name = session.model.split("[")[0];
  if (
    name === "retired" ||
    text.includes("REJECT_ALL") ||
    (text.includes("REJECT_MODEL") && name === "current")
  ) {
    return fail(id, `The '${name}' model is not supported when using Codex with a ChatGPT account.`);
  }

  if (text.includes("SHOW_MODEL")) reply = `model ${session.model}`;
  if (text.includes("WHICH_MODE")) reply = `mode ${session.mode}`;
  if (text.includes("SHOW_MCP")) reply = `mcp ${JSON.stringify(session.mcpServers)}`;
  if (text.includes("SHOW_CWD")) reply = `cwd ${session.cwd} ${fs.readdirSync(session.cwd).length}`;
  if (text.includes("SHOW_PID")) reply = `pid ${process.pid}`;

  if (text.includes("REFUSAL")) {
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "I can't help with that." },
    });
    return respond(id, { stopReason: "refusal" });
  }

  const slow = text.includes("SLOW");
  const words = text.includes("SHOW_PROMPT")
    ? [text]
    : slow
      ? Array(200).fill("word ")
      : reply.split(/(?<= )/);
  for (const word of words) {
    if (cancelled.delete(sessionId)) return respond(id, { stopReason: "cancelled" });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: word } });
    await sleep(slow ? 20 : 2);
  }
  cancelled.delete(sessionId);
  if (flavor !== "codex") update(sessionId, { sessionUpdate: "usage_update", used: 2400, size: 200000 });
  respond(id, { stopReason: "end_turn" });
}

if (flavor === "opencode") process.stdout.write("[plugin] loading (project: mock)\n");

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params = {} } = message;

  // An answer to something the mock asked.
  if (method === undefined) {
    waitingOnClient.get(id)?.(message);
    waitingOnClient.delete(id);
    return;
  }

  switch (method) {
    case "initialize":
      // The version is a number. A string is what a guess at the protocol
      // sends, and a real agent turns it down.
      if (typeof params.protocolVersion !== "number")
        return fail(id, "protocolVersion must be a number", -32602);
      respond(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: !process.argv.includes("--no-http-mcp") },
          sessionCapabilities: { resume: {} },
        },
        agentInfo: { name: `mock-${flavor}`, version: "0.0.0" },
      });
      break;
    case "session/new": {
      // Required, even empty: a real agent rejects a session without it.
      if (!Array.isArray(params.mcpServers)) return fail(id, "mcpServers is required", -32602);
      const sessionId = `mock-session-${++sessionCounter}`;
      const session = {
        mode: MODES[flavor]?.current ?? "none",
        model: flavor === "codex" ? "retired[low]" : "sonnet",
        mcpServers: params.mcpServers,
        cwd: params.cwd,
      };
      sessions.set(sessionId, session);
      respond(id, { sessionId, ...modesOf(session), ...modelsOf(session) });
      break;
    }
    case "session/resume": {
      const session = sessions.get(params.sessionId);
      if (!session) return fail(id, "Session not found");
      session.mcpServers = params.mcpServers ?? [];
      session.cwd = params.cwd;
      respond(id, { ...modesOf(session), ...modelsOf(session) });
      break;
    }
    case "session/set_mode": {
      const session = sessions.get(params.sessionId);
      if (!session) return fail(id, "Session not found");
      if (!MODES[flavor]) return fail(id, `Invalid params: mode not found: ${params.modeId}`, -32602);
      if (!MODES[flavor].available.includes(params.modeId)) return fail(id, "Invalid Mode");
      session.mode = params.modeId;
      respond(id, {});
      break;
    }
    case "session/set_model": {
      const session = sessions.get(params.sessionId);
      if (!session || flavor !== "codex") return fail(id, `unknown method: ${method}`, -32601);
      session.model = params.modelId;
      respond(id, {});
      break;
    }
    case "session/set_config_option": {
      const session = sessions.get(params.sessionId);
      if (!session) return fail(id, "Session not found");
      if (params.configId === "model") session.model = params.value;
      else if (params.configId === "mode") session.mode = params.value;
      respond(id, modelsOf(session));
      break;
    }
    case "session/cancel":
      // A notification: never answered itself. A turn that had wedged ends
      // now, as cancelled; one that is talking stops at its next word.
      if (stalled.has(params.sessionId)) {
        respond(stalled.get(params.sessionId), { stopReason: "cancelled" });
        stalled.delete(params.sessionId);
      } else cancelled.add(params.sessionId);
      break;
    case "session/prompt":
      void prompt(id, params);
      break;
    default:
      if (id !== undefined) fail(id, `unknown method: ${method}`, -32601);
  }
});
