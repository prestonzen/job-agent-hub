#!/usr/bin/env node
// Job Agent Hub runner: claims agent runs from the hub, starts the agent's CLI headless,
// streams its output back, and stops it when the run is cancelled or times out.
// Zero dependencies (Node 22+). Config: /etc/job-agent-runner/config.json (see config.example.json).
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { basename, join } from "node:path";

const VERSION = "0.1.0";
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
const TIMEOUT_MS = (cfg.timeoutMinutes ?? 90) * 60_000;
const WORK = cfg.workDir ?? "/var/lib/job-agent-runner/runs";
// Read by update.sh: it only restarts the runner when nothing is running.
const STATE = cfg.stateFile ?? join(WORK, "..", "state.json");

function log(...a) { console.log(new Date().toISOString(), ...a); }
const expand = (p) => (p?.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
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

function probe() {
  reloadCfg();
  return Object.entries(cfg.agents ?? {}).map(([id, a]) => {
    const bin = a.cmd?.[0];
    const installed = !!bin && spawnSync("sh", ["-c", `command -v "${bin}"`]).status === 0;
    const authOk = !a.auth || [].concat(a.auth).some((p) => existsSync(expand(p)));
    let version = null;
    if (installed && a.versionArgs !== false) {
      const v = spawnSync(bin, a.versionArgs ?? ["--version"], { encoding: "utf8", timeout: 15_000 });
      version = (v.stdout || v.stderr || "").trim().split("\n")[0]?.slice(0, 80) || null;
    }
    return { id, installed, ready: installed && authOk && a.enabled !== false, version, note: !installed ? "not installed" : !authOk ? "not logged in" : a.enabled === false ? (a.note ?? "disabled in config") : null };
  });
}

let agents = probe();
const active = new Map(); // runId -> { child, buf, cancelled, timedOut }

function saveState() {
  try { writeFileSync(STATE, JSON.stringify({ busy: active.size, runs: [...active.keys()], at: new Date().toISOString() })); } catch {}
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
  const prompt = cfg.machineNotes ? `${run.fullPrompt}\n\nNOTES FOR THIS MACHINE:\n${cfg.machineNotes}` : run.fullPrompt;
  const LOGIN = { codex: ["codex", "login", "--device-auth"], kimi: ["kimi", "login"] };
  const [bin, ...rest] = run.kind === "login" ? (a.loginCmd ?? LOGIN[run.agent] ?? ["false"]) : a.cmd;
  const args = rest.map((x) => (x === "{PROMPT}" ? prompt : x));
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

  const child = spawn(bin, args, {
    cwd,
    env: { ...process.env, ...(cfg.env ?? {}), ...(a.env ?? {}), JOB_AGENT_RUN_ID: String(run.id) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group, so cancel kills the CLI and its browser/MCP children
  });
  const state = { child, buf: `[runner ${NAME}] run #${run.id}: ${run.agent} (${run.kind}) started\n`, cancelled: false, timedOut: false };
  active.set(run.id, state);
  saveState();
  log(`run #${run.id} ${run.agent} pid ${child.pid}`);

  const fmt = FORMATTERS[a.format];
  let partial = "";
  const onOut = (d) => {
    if (!fmt) return void (state.buf += stripAnsi(d.toString()));
    partial += d.toString();
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    for (const l of lines) if (l.trim()) state.buf += fmt(l);
  };
  child.stdout.on("data", onOut);
  child.stderr.on("data", (d) => (state.buf += stripAnsi(d.toString())));

  const kill = (why) => {
    state.buf += `\n[runner] stopping: ${why}\n`;
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 10_000).unref();
  };
  state.kill = kill;
  const timer = setTimeout(() => { state.timedOut = true; kill(`timeout after ${TIMEOUT_MS / 60_000} min`); }, TIMEOUT_MS);

  const flusher = setInterval(() => flush(run.id), 2_000);
  child.on("error", (e) => (state.buf += `\n[runner] failed to start: ${e.message}\n`));
  child.on("close", async (code, signal) => {
    clearTimeout(timer);
    clearInterval(flusher);
    state.buf += `\n[runner] exited ${signal ? `by ${signal}` : `with code ${code}`}\n`;
    await flush(run.id);
    try {
      await hub(`/api/runner/runs/${run.id}/finish`, { exitCode: state.timedOut ? 124 : code, cancelled: state.cancelled });
    } catch (e) {
      log(`finish #${run.id} failed:`, e.message);
    }
    active.delete(run.id);
    saveState();
    if (run.kind === "login") { agents = probe(); void heartbeat(); } // show the new login right away
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
  if (active.size >= maxSlots()) return;
  const ready = agents.filter((a) => a.ready).map((a) => a.id);
  const installed = agents.filter((a) => a.installed).map((a) => a.id);
  if (!installed.length) return;
  try {
    const { run } = await hub("/api/runner/claim", { agents: ready, installed });
    if (run) {
      active.set(run.id, { child: null, buf: "", cancelled: false, timedOut: false, kill: () => {} }); // reserve the slot
      await startRun(run);
    }
  } catch (e) {
    log("claim failed:", e.message);
  }
}

// ---------- main ----------

log(`runner ${NAME} v${VERSION}: ${maxSlots()} slots; agents: ${agents.map((a) => `${a.id}=${a.ready ? "ready" : a.note}`).join(", ")}`);
await heartbeat();
setInterval(heartbeat, 30_000);
setInterval(() => { agents = probe(); }, 5 * 60_000); // pick up new logins without a restart
setInterval(claimLoop, 5_000);
void claimLoop();

const shutdown = () => {
  log("shutting down; stopping runs");
  for (const s of active.values()) s.kill?.("runner shutting down");
  setTimeout(() => process.exit(0), 12_000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
