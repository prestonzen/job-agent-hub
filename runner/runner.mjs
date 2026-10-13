#!/usr/bin/env node
// Job Agent Hub runner: claims agent runs from the hub, starts the agent's CLI headless,
// streams its output back, and stops it when the run is cancelled or times out.
// Zero dependencies (Node 22+). Config: /etc/job-agent-runner/config.json (see config.example.json).
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { basename, join } from "node:path";

import { kimiUsage } from "./usage.mjs";
const VERSION = "0.3.0";
const CONFIG_PATH = process.env.RUNNER_CONFIG ?? "/etc/job-agent-runner/config.json";
let cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
/** Re-read the config file so edits (commands, models, notes, tokens) apply to the next run without a restart. */
function reloadCfg() {
  try {
    cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    log("config reload failed, keeping the previous one:", e.message);
  }
}
const NAME = cfg.name ?? hostname();
// Read live from the config (reloadCfg) so capacity can be tuned without a restart.
const maxSlots = () => Math.max(1, cfg.slots ?? 2);
const WORK = cfg.workDir ?? "/var/lib/job-agent-runner/runs";
// Read by update.sh: it only restarts the runner when nothing is running.
const STATE = cfg.stateFile ?? join(WORK, "..", "state.json");

function log(...a) { console.log(new Date().toISOString(), ...a); }
const expand = (p) => (p?.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** KEY=VALUE lines of an env file (quotes stripped); missing file = nothing. */
function readEnvFile(p) {
  const out = {};
  try {
    for (const l of readFileSync(expand(p), "utf8").split(/\r?\n/)) {
      const m = l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch {
    /* no file */
  }
  return out;
}

/**
 * Environment for an agent CLI: the runner config's env, then the agent's env file (so an API key can live
 * in a root-managed file, not in config.json), then envMap renames ({ ANTHROPIC_AUTH_TOKEN: "DEEPSEEK_API_KEY" }),
 * then the agent's own env. Values may start with ~/ .
 */
function agentEnv(a) {
  const file = a.envFile ? readEnvFile(a.envFile) : {};
  const mapped = Object.fromEntries(Object.entries(a.envMap ?? {}).filter(([, src]) => file[src] !== undefined).map(([dst, src]) => [dst, file[src]]));
  const own = Object.fromEntries(Object.entries(a.env ?? {}).map(([k, v]) => [k, typeof v === "string" ? expand(v) : v]));
  return { ...(cfg.env ?? {}), ...file, ...mapped, ...own };
}
// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07|\r(?!\n)/g, "");

async function hubGet(path) {
  const res = await fetch(`${cfg.hub}${path}`, { headers: { Authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res;
}

// Resume bank: cache every variant locally (keyed by id + size), copy into each run's ./resumes/.
const CACHE = join(WORK, "..", "resume-cache");
async function syncResumes() {
  mkdirSync(CACHE, { recursive: true });
  const { resumes } = await (await hubGet("/api/runner/resumes")).json();
  const files = [];
  for (const r of resumes) {
    const local = join(CACHE, `${r.id}-${r.size}-${basename(r.filename)}`);
    if (!existsSync(local)) writeFileSync(local, Buffer.from(await (await hubGet(`/api/runner/resumes/${r.id}/file`)).arrayBuffer()));
    files.push({ local, filename: basename(r.filename) });
  }
  return files;
}

async function hub(path, body) {
  const res = await fetch(`${cfg.hub}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: NAME, ...body }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ---------- which agents can run here ----------

async function probe() {
  reloadCfg();
  const results = Object.entries(cfg.agents ?? {}).map(([id, a]) => {
    const bin = a.probeBin ?? a.cmd?.[0];
    const installed = !!bin && spawnSync("sh", ["-c", `command -v "${bin}"`]).status === 0;
    const authOk = !a.auth || [].concat(a.auth).some((p) => existsSync(expand(p)) && (!a.authNeeds || a.authNeeds.every((v) => readEnvFile(a.envFile ?? p)[v])));
    let version = null;
    if (installed && a.versionArgs !== false) {
      const v = spawnSync(bin, a.versionArgs ?? ["--version"], { encoding: "utf8", timeout: 15_000 });
      version = (v.stdout || v.stderr || "").trim().split("\n")[0]?.slice(0, 80) || null;
    }
    return { id, installed, signedIn: id === "ollama" ? null : installed && authOk, ready: installed && authOk && a.enabled !== false, version, note: !installed ? "not installed" : !authOk ? "not logged in" : a.enabled === false ? (a.note ?? "disabled in config") : null };
  });
  const ollama = results.find((a) => a.id === "ollama");
  if (ollama?.ready) {
    const o = cfg.agents.ollama.hermes ?? {};
    try {
      const res = await fetch(`${o.ollamaUrl ?? "http://127.0.0.1:11434"}/api/tags`, { signal: AbortSignal.timeout(5000) });
      const tags = await res.json();
      if (!res.ok || !(tags.models ?? []).some((m) => m.name === (o.model ?? "gemma4:26b"))) { ollama.ready = false; ollama.note = "Configured Ollama model is unavailable"; }
    } catch { ollama.ready = false; ollama.note = "Ollama server is unreachable"; }
  }
  return results;
}

let agents = await probe();
const active = new Map(); // runId -> { child, buf, cancelled, timedOut }
const DRAIN = '/run/job-agent-runner.drain';
let claiming = false;

function saveState() {
  try { writeFileSync(STATE, JSON.stringify({ busy: active.size, runs: [...active.keys()], draining:existsSync(DRAIN), claiming, at: new Date().toISOString() })); } catch {}
}

async function heartbeat() {
  saveState();
  try {
    await hub("/api/runner/heartbeat", { agents, slots: maxSlots(), busy: active.size, version: VERSION, host: hostname(), active: [...active.keys()] });
  } catch (e) {
    log("heartbeat failed:", e.message);
  }
}

// ---------- readable logs from JSON event streams ----------

const short = (v, n = 140) => {
  const t = typeof v === "string" ? v : JSON.stringify(v);
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** Claude Code `--output-format stream-json --verbose`: one JSON event per line → human lines. */
function formatClaudeEvent(line) {
  let e;
  try { e = JSON.parse(line); } catch { return line + "\n"; }
  if (e.type === "assistant") {
    return (e.message?.content ?? [])
      .map((c) => (c.type === "text" ? `${c.text.trim()}\n` : c.type === "tool_use" ? `→ ${c.name.replace(/^mcp__/, "")} ${short(c.input)}\n` : ""))
      .join("");
  }
  if (e.type === "user") {
    return (e.message?.content ?? [])
      .filter((c) => c.type === "tool_result" && c.is_error)
      .map((c) => `  ✗ ${short(Array.isArray(c.content) ? c.content.map((x) => x.text ?? "").join(" ") : c.content, 200)}\n`)
      .join("");
  }
  if (e.type === "result") return `\n=== ${e.subtype ?? "result"}${e.total_cost_usd ? ` · $${e.total_cost_usd.toFixed(2)}` : ""}${e.num_turns ? ` · ${e.num_turns} turns` : ""} ===\n${e.result ?? ""}\n`;
  if (e.type === "system" && e.subtype === "init") return `[session ${e.model ?? ""} · ${(e.mcp_servers ?? []).map((m) => `${m.name}:${m.status}`).join(", ")}]\n`;
  return "";
}

const FORMATTERS = { "claude-stream": formatClaudeEvent };

// ---------- running one job ----------

async function startRun(run) {
  reloadCfg();
  const a = cfg.agents[run.agent];
  const taskGuard=run.task==='cyber'?'CYBER EVIDENCE RULES: Operate only within the scope explicitly authorized in the task. Prefer offline triage or drafting; never expand scope or submit bounty reports. Separate observed facts from hypotheses. HTTP 200 alone is not evidence of secrets; archived data is not proof of current exposure; metadata, public assets and absent headers do not justify high severity without impact. Propose the smallest authorized validation step and redact sensitive evidence. Never claim you performed checks you did not perform.':run.task==='email'?'EMAIL TASK: Use only the employer-advertised application email on your claimed job and the hub email_application helper. Do not browse ATS forms, guess contacts or send followups. One application at a time; record the mailer receipt and selected resume.':'';
  run.fullPrompt+=`\n\n${taskGuard}`;
  const prompt = cfg.machineNotes ? `${run.fullPrompt}\n\nNOTES FOR THIS MACHINE:\n${cfg.machineNotes}` : run.fullPrompt;
  const LOGIN = { codex: ["codex", "login", "--device-auth"], kimi: ["kimi", "login"] };
  const [bin, ...rest] = run.kind === "login" ? (a.loginCmd ?? LOGIN[run.agent] ?? ["false"]) : (a.taskCommands?.[run.task] ?? a.cmd);
  // Commands use spawn rather than a shell, so paths such as ~/.gemini/.env need expansion here.
  const args = rest.map((x) => (x === "{PROMPT}" ? prompt : expand(x)));
  const cwd = join(WORK, String(run.id));
  mkdirSync(cwd, { recursive: true });
  // Only these files (e.g. the resume) are put where the agent's browser may upload from.
  for (const f of cfg.files ?? []) {
    try { copyFileSync(expand(f), join(cwd, basename(f))); } catch (e) { log(`copy ${f} failed:`, e.message); }
  }
  try {
    const bank = await syncResumes();
    if (bank.length) mkdirSync(join(cwd, "resumes"), { recursive: true });
    for (const b of bank) copyFileSync(b.local, join(cwd, "resumes", b.filename));
  } catch (e) {
    log("resume bank sync failed:", e.message);
  }

  const runEnv = {...agentEnv(a),...Object.fromEntries(Object.entries(a.taskEnvs?.[run.task]??{}).map(([key,value])=>[key,typeof value==="string"?expand(value):value]))};
  // Every task uses the canonical hub identity, including email and cyber prompts that call REST.
  if (cfg.agentTokens?.[run.agent]) runEnv.JOBHUNTER_TOKEN = cfg.agentTokens[run.agent];
  const child = spawn(bin, args, {
    cwd,
    env: { ...process.env, ...runEnv, JOB_AGENT_RUN_ID: String(run.id) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group, so cancel kills the CLI and its browser/MCP children
  });
  const state = { child, buf: `[runner ${NAME}] run #${run.id}: ${run.agent} (${run.kind}) started\n`, cancelled: false, timedOut: false, costUsd: null, tokens: null };
  state.buf+=`[task profile] ${run.task}: ${a.taskHarnesses?.[run.task]??a.harness??run.agent} · ${a.taskModels?.[run.task]??a.hermes?.model??"configured model"}\n`;
  active.set(run.id, state);
  saveState();
  log(`run #${run.id} ${run.agent} pid ${child.pid}`);

  const fmt = FORMATTERS[a.taskFormats?.[run.task] ?? a.format];
  let partial = "";
  // Cost/token accounting, reported to the hub on finish: Claude's stream carries total_cost_usd;
  // other CLIs get a tolerant "tokens used: 12,345" scan of their raw output.
  const trackUsage = (raw, jsonLine) => {
    if (jsonLine) {
      try {
        const e = JSON.parse(jsonLine);
        if (e.type === "result" && typeof e.total_cost_usd === "number") state.costUsd = e.total_cost_usd;
        const u = e.usage ?? e.message?.usage;
        if (u) {
          const t = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
          if (t > 0) state.tokens = (state.tokens ?? 0) + t;
        }
      } catch {}
      return;
    }
    const m = raw.match(/tokens?\s+used[:\s]+([\d,]+)/i);
    if (m) state.tokens = Number(m[1].replace(/,/g, ""));
    const c = raw.match(/(?:total\s+)?cost[:\s]+\$?([\d.]+)/i);
    if (c && state.costUsd == null) state.costUsd = Number(c[1]);
  };
  const onOut = (d) => {
    const raw = d.toString();
    if (!fmt) {
      state.buf += stripAnsi(raw);
      trackUsage(raw, null);
      return;
    }
    partial += raw;
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    for (const l of lines) if (l.trim()) { state.buf += fmt(l); trackUsage(null, l); }
  };
  child.stdout.on("data", onOut);
  child.stderr.on("data", (d) => { const raw = d.toString(); state.buf += stripAnsi(raw); trackUsage(raw, null); });

  const kill = (why) => {
    state.buf += `\n[runner] stopping: ${why}\n`;
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 10_000).unref();
  };
  state.kill = kill;
  const timeoutMs=(a.taskTimeoutMinutes?.[run.task]??cfg.timeoutMinutes??90)*60_000;
  const timer = setTimeout(() => { state.timedOut = true; kill(`timeout after ${timeoutMs / 60_000} min`); }, timeoutMs);

  const flusher = setInterval(() => flush(run.id), 2_000);
  child.on("error", (e) => (state.buf += `\n[runner] failed to start: ${e.message}\n`));
  child.on("close", async (code, signal) => {
    clearTimeout(timer);
    clearInterval(flusher);
    state.buf += `\n[runner] exited ${signal ? `by ${signal}` : `with code ${code}`}\n`;
    if(run.agent === "kimi") {
      try { const usage=kimiUsage(homedir(),cwd); if(usage){state.tokens=usage.tokens;state.buf+=`[usage] ${usage.tokens} tokens from ${usage.records} Kimi turns\n`;} } catch(e){ log("Kimi usage unavailable:",e.message); }
    }
    await flush(run.id);
    try {
      await hub(`/api/runner/runs/${run.id}/finish`, { exitCode: state.timedOut ? 124 : code, cancelled: state.cancelled, costUsd: state.costUsd, tokens: state.tokens });
    } catch (e) {
      log(`finish #${run.id} failed:`, e.message);
    }
    active.delete(run.id);
    saveState();
    if (run.kind === "login") { agents = await probe(); void heartbeat(); } // show the new login right away
    log(`run #${run.id} done (${code ?? signal})`);
  });
}

async function flush(id) {
  const s = active.get(id);
  if (!s) return;
  if (!s.buf) {
    // Silent agent: still ask the hub every 10 s whether the run was cancelled.
    if (Date.now() - (s.lastPoll ?? 0) < 10_000) return;
    s.lastPoll = Date.now();
  }
  const chunk = s.buf;
  s.buf = "";
  try {
    const { cancel } = await hub(`/api/runner/runs/${id}/log`, { chunk });
    if (cancel && !s.cancelled) {
      s.cancelled = true;
      s.kill("cancelled from the hub");
    }
  } catch (e) {
    s.buf = chunk + s.buf; // retry next tick
    log(`log #${id} failed:`, e.message);
  }
}

async function claimLoop() {
  reloadCfg(); // pick up slot/config changes without a restart
  if(claiming)return;
  if(existsSync(DRAIN)){saveState();return;}
  if (active.size >= maxSlots()) return;
  const ready = agents.filter((a) => a.ready).map((a) => a.id);
  const installed = agents.filter((a) => a.installed).map((a) => a.id);
  if (!installed.length) return;
  claiming=true;
  saveState();
  try {
    const { run } = await hub("/api/runner/claim", { agents: ready, installed });
    if (run) {
      active.set(run.id, { child: null, buf: "", cancelled: false, timedOut: false, kill: () => {} }); // reserve the slot
      saveState();
      await startRun(run);
    }
  } catch (e) {
    log("claim failed:", e.message);
  } finally {claiming=false;saveState();}
}

// ---------- main ----------

log(`runner ${NAME} v${VERSION}: ${maxSlots()} slots; agents: ${agents.map((a) => `${a.id}=${a.ready ? "ready" : a.note}`).join(", ")}`);
await heartbeat();
setInterval(heartbeat, 30_000);
setInterval(async () => { agents = await probe(); }, 5 * 60_000); // pick up new logins without a restart
setInterval(claimLoop, 5_000);
void claimLoop();

const shutdown = () => {
  log("shutting down; stopping runs");
  for (const s of active.values()) s.kill?.("runner shutting down");
  setTimeout(() => process.exit(0), 12_000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
