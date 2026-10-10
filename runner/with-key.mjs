#!/usr/bin/env node
// Runs an agent CLI with one API key out of several, so free-tier keys can be load-balanced.
//
//   node with-key.mjs --var GEMINI_API_KEY --keys ~/.gemini/keys [--env-file ~/.gemini/.env] -- gemini --yolo -p "<prompt>"
//
// Keys come from the keys file (one per line, `#` comments allowed) plus the first key in the env file.
// Each run starts on the next key in turn. If the CLI stops because that key's quota is used up
// ("exceeded your current quota", "Please retry in 24m"), the key is rested (until its retry time, at
// least 30 min) and the same command is started again on the next key. When every key is resting, the
// last quota error is passed through and the process exits 1, so the hub rests the whole agent.
// Keys are never printed. State lives in <keys file>.state.json.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const expand = (p) => (p?.startsWith("~/") ? homedir() + p.slice(1) : p);
const argv = process.argv.slice(2);
const dd = argv.indexOf("--");
if (dd < 0 || dd === argv.length - 1) {
  console.error("usage: with-key.mjs --var NAME --keys FILE [--env-file FILE] -- cmd args…");
  process.exit(2);
}
const opts = argv.slice(0, dd);
const [bin, ...args] = argv.slice(dd + 1);
const opt = (name) => {
  const i = opts.indexOf(name);
  return i >= 0 ? opts[i + 1] : null;
};
const VAR = opt("--var");
const keysFile = expand(opt("--keys"));
const envFile = expand(opt("--env-file"));
if (!VAR || !keysFile) {
  console.error("--var and --keys are required");
  process.exit(2);
}

const QUOTA = /exceeded your (current )?quota|quota exceeded|RESOURCE_EXHAUSTED|TerminalQuotaError|insufficient_quota|rate.?limit(ed)? (reached|exceeded)|usage limit/i;
const MIN_REST_MS = 30 * 60_000;
const MAX_REST_MS = 24 * 3_600_000;

function readKeys() {
  const out = [];
  const add = (k) => k && !out.includes(k) && out.push(k);
  if (envFile && existsSync(envFile)) {
    const m = readFileSync(envFile, "utf8").match(new RegExp(`^\\s*${VAR}\\s*=\\s*['"]?([^'"\\s]+)`, "m"));
    add(m?.[1]);
  }
  if (existsSync(keysFile)) for (const l of readFileSync(keysFile, "utf8").split(/\r?\n/)) add(l.replace(/#.*$/, "").trim());
  return out;
}

const statePath = `${keysFile}.state.json`;
const loadState = () => {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return { next: 0, resting: {} };
  }
};
const saveState = (s) => writeFileSync(statePath, JSON.stringify(s), { mode: 0o600 });
const id = (k) => createHash("sha256").update(k).digest("hex").slice(0, 10);

const keys = readKeys();
if (!keys.length) {
  console.error(`[with-key] no ${VAR} found in ${keysFile}${envFile ? ` or ${envFile}` : ""}`);
  process.exit(1);
}

function retryMs(text) {
  const m = text.match(/retry in (?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:([\d.]+)s)?/i);
  const ms = m ? ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000 : 0;
  return Math.min(MAX_REST_MS, Math.max(MIN_REST_MS, ms + 60_000));
}

function runOnce(key) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: { ...process.env, [VAR]: key }, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const keep = (d) => {
      tail = (tail + d.toString()).slice(-6000);
    };
    child.stdout.on("data", (d) => {
      keep(d);
      process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      keep(d);
      process.stderr.write(d);
    });
    child.on("error", (e) => resolve({ code: 127, tail: String(e.message) }));
    child.on("close", (code) => resolve({ code: code ?? 1, tail }));
    for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => child.kill(sig));
  });
}

let state = loadState();
let last = { code: 1, tail: "" };
for (let attempt = 0; attempt < keys.length; attempt++) {
  state = loadState();
  const now = Date.now();
  // Next usable key in rotation order.
  let pick = -1;
  for (let step = 0; step < keys.length; step++) {
    const i = (state.next + step) % keys.length;
    if ((state.resting[id(keys[i])] ?? 0) <= now) {
      pick = i;
      break;
    }
  }
  if (pick < 0) {
    console.error(`[with-key] all ${keys.length} key(s) are resting; ${last.tail ? "passing the last quota error through" : "nothing to run"}`);
    if (last.tail) process.stderr.write(last.tail.slice(-1500));
    process.exit(1);
  }
  state.next = (pick + 1) % keys.length;
  saveState(state);
  console.error(`[with-key] using key ${pick + 1} of ${keys.length}`);
  last = await runOnce(keys[pick]);
  if (last.code === 0) process.exit(0);
  if (!QUOTA.test(last.tail)) process.exit(last.code);
  const rest = retryMs(last.tail);
  state = loadState();
  state.resting[id(keys[pick])] = Date.now() + rest;
  saveState(state);
  console.error(`[with-key] key ${pick + 1} is out of quota; resting it ${Math.round(rest / 60_000)} min${attempt + 1 < keys.length ? " and trying the next key" : ""}`);
}
if (last.tail) process.stderr.write(last.tail.slice(-1500));
process.exit(last.code || 1);
