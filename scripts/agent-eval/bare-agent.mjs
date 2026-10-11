#!/usr/bin/env node
// The thinnest possible agent harness: a model, MCP tools, a loop. No system-prompt scaffolding beyond a few lines,
// no skills, no planning layer. Used to measure how much a full harness (Claude Code, Hermes) actually adds.
//
//   node bare-agent.mjs --model gemma4:26b --prompt-file prompt.txt [--ollama http://127.0.0.1:11434]
//        [--max-turns 80] [--ctx 65536] [--mcp playwright] [--hub-url https://…/mcp --hub-token …]
//
// The model is called through Ollama's native /api/chat with tools. MCP servers are the same ones the real
// agents use (Playwright MCP over stdio, optionally the hub over HTTP). Old tool outputs are shrunk so a long
// browsing session doesn't drown the context: the newest KEEP_FULL outputs stay intact.
import { readFileSync } from "node:fs";
import { Agent, fetch as ufetch } from "undici";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const MODEL = opt("--model");
const OLLAMA = opt("--ollama", "http://127.0.0.1:11434");
const MAX_TURNS = Number(opt("--max-turns", 80));
const NUM_CTX = Number(opt("--ctx", 65536));
const PROMPT = readFileSync(opt("--prompt-file"), "utf8");
const KEEP_FULL = 3;
// A big local model can take many minutes to load and think; Node's default 5-minute header timeout would kill the run.
const slowAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
const NUDGES = Number(opt("--nudges", 3));
let nudges = 0;
let parseFails = 0;
const OUT_CAP = 24_000;
if (!MODEL) {
  console.error("--model is required");
  process.exit(2);
}

const clients = [];
const toolOwner = new Map();
const tools = [];
async function connect(name, transport) {
  const c = new Client({ name: `bare-${name}`, version: "1.0.0" });
  await c.connect(transport);
  clients.push(c);
  for (const t of (await c.listTools()).tools) {
    toolOwner.set(t.name, c);
    tools.push({ type: "function", function: { name: t.name, description: (t.description ?? "").slice(0, 600), parameters: t.inputSchema ?? { type: "object", properties: {} } } });
  }
}
if (opt("--mcp", "playwright").split(",").includes("playwright")) {
  await connect(
    "playwright",
    new StdioClientTransport({
      command: "playwright-mcp",
      args: ["--isolated", "--browser", "chromium", "--image-responses", "omit", "--output-dir", ".playwright"],
      env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ":99", PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/ms-playwright" },
    }),
  );
}
if (opt("--hub-url")) {
  await connect("hub", new StreamableHTTPClientTransport(new URL(opt("--hub-url")), { requestInit: { headers: { Authorization: `Bearer ${opt("--hub-token", "")}` } } }));
}

const messages = [
  { role: "system", content: "You are an agent that completes tasks by calling the provided tools. Think briefly, call one tool at a time, check results, and stop when the task is finished." },
  { role: "user", content: PROMPT },
];

const shrink = () => {
  const toolIdx = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - KEEP_FULL))) {
    const c = messages[i].content;
    if (c.length > 300 && !c.startsWith("[older output")) messages[i].content = `[older output trimmed] ${c.slice(0, 200)}…`;
  }
};

let finalText = "";
for (let turn = 1; turn <= MAX_TURNS; turn++) {
  shrink();
  const res = await ufetch(`${OLLAMA}/api/chat`, {
    dispatcher: slowAgent,
    method: "POST",
    body: JSON.stringify({ model: MODEL, messages, tools, stream: false, options: { num_ctx: NUM_CTX, temperature: 0.2 } }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    // Some models (gpt-oss) now and then mix prose into a tool call and Ollama can't parse it: just ask again.
    if (/error parsing tool call|tool call/i.test(body) && parseFails < 6) {
      parseFails++;
      console.error(`[bare] turn ${turn}: malformed tool call from the model (${parseFails}/6), resampling`);
      turn--;
      continue;
    }
    console.error(`[bare] ollama ${res.status}: ${body}`);
    break;
  }
  parseFails = 0;
  const { message } = await res.json();
  messages.push({ role: "assistant", content: message.content ?? "", ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) });
  if (!message.tool_calls?.length) {
    finalText = message.content ?? "";
    // A model that stops early (empty reply, or a plan with no action) gets a few reminders before we accept it.
    if (!/\bDONE\b/.test(finalText) && nudges < NUDGES) {
      nudges++;
      console.error(`[bare] turn ${turn}: no tool call and no DONE (reply: ${JSON.stringify(finalText.slice(0, 120))}); nudging ${nudges}/${NUDGES}`);
      messages.push({ role: "user", content: "You have not finished. Continue the task with the tools. Only reply with DONE and the reference number once the site confirmed the application was received." });
      continue;
    }
    console.error(`[bare] finished after ${turn} turn(s)`);
    break;
  }
  for (const call of message.tool_calls) {
    const name = call.function.name;
    let out;
    try {
      const owner = toolOwner.get(name);
      if (!owner) throw new Error(`unknown tool ${name}`);
      const args2 = typeof call.function.arguments === "string" ? JSON.parse(call.function.arguments) : call.function.arguments ?? {};
      const r = await owner.callTool({ name, arguments: args2 });
      out = (r.content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
      if (r.isError) out = `ERROR: ${out}`;
    } catch (e) {
      out = `ERROR: ${e.message}`;
    }
    console.error(`[bare] turn ${turn}: ${name}(${JSON.stringify(call.function.arguments).slice(0, 110)}) -> ${out.slice(0, 90).replace(/\n/g, " ")}`);
    messages.push({ role: "tool", tool_name: name, content: out.length > OUT_CAP ? out.slice(0, OUT_CAP) + "\n[truncated]" : out });
  }
}
console.log(finalText);
for (const c of clients) await c.close().catch(() => {});
process.exit(0);
