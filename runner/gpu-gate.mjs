#!/usr/bin/env node
// Lets a local-GPU agent (Ollama + Hermes) share a machine with ComfyUI / LTX video generation.
// ComfyUI always wins: the agent only runs while ComfyUI is idle, pauses the instant a render starts,
// and gives the GPU memory back (the model is unloaded) until the render is done.
//
//   node gpu-gate.mjs [--comfy http://127.0.0.1:8188] [--ollama http://127.0.0.1:11434]
//                     [--idle 20] [--wait-max 1200] [--pause-max 3600] -- hermes chat …
//
// 1. Before starting: wait until ComfyUI's queue has been empty for --idle seconds (up to --wait-max;
//    if it never is, exit 0 without starting, so no jobs are claimed and nothing is wasted).
// 2. While running: poll the queue every 5 s. Busy -> SIGSTOP the whole agent process group (the model
//    server finishes any in-flight request, then the model is unloaded). Idle again -> SIGCONT.
// 3. Paused longer than --pause-max: stop the run (exit 75) so held jobs expire back into the queue.
// 4. On exit the model is unloaded, so an idle agent holds no GPU memory.
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const dd = argv.indexOf("--");
if (dd < 0 || dd === argv.length - 1) {
  console.error("usage: gpu-gate.mjs [options] -- command args…");
  process.exit(2);
}
const opts = argv.slice(0, dd);
const [bin, ...args] = argv.slice(dd + 1);
const opt = (name, d) => {
  const i = opts.indexOf(name);
  return i >= 0 ? opts[i + 1] : d;
};
const COMFY = opt("--comfy", "http://127.0.0.1:8188");
const OLLAMA = opt("--ollama", "http://127.0.0.1:11434");
const IDLE_S = Number(opt("--idle", 20));
const WAIT_MAX_S = Number(opt("--wait-max", 1200));
const PAUSE_MAX_S = Number(opt("--pause-max", 3600));
const POLL_MS = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => console.error(`[gpu-gate] ${m}`);

/** True while ComfyUI is rendering or has queued work. An unreachable ComfyUI counts as idle. */
async function comfyBusy() {
  try {
    const res = await fetch(`${COMFY}/queue`, { signal: AbortSignal.timeout(4000) });
    const q = await res.json();
    return (q.queue_running?.length ?? 0) + (q.queue_pending?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

async function unloadModels() {
  try {
    const ps = await (await fetch(`${OLLAMA}/api/ps`, { signal: AbortSignal.timeout(4000) })).json();
    for (const m of ps.models ?? []) {
      await fetch(`${OLLAMA}/api/generate`, {
        method: "POST",
        body: JSON.stringify({ model: m.name, keep_alive: 0 }),
        signal: AbortSignal.timeout(15000),
      }).catch(() => {});
    }
  } catch {
    /* Ollama not running: nothing to unload */
  }
}

// ---- 1. wait for a quiet GPU ----
const waitStart = Date.now();
let quietSince = null;
for (;;) {
  if (await comfyBusy()) quietSince = null;
  else quietSince ??= Date.now();
  if (quietSince && Date.now() - quietSince >= IDLE_S * 1000) break;
  if (Date.now() - waitStart > WAIT_MAX_S * 1000) {
    say(`ComfyUI stayed busy for ${Math.round(WAIT_MAX_S / 60)} min; skipping this run (nothing claimed)`);
    process.exit(0);
  }
  await sleep(POLL_MS);
}
say("ComfyUI is idle; starting");

// ---- 2. run, yielding to ComfyUI ----
const child = spawn(bin, args, { stdio: "inherit", detached: true }); // own process group, so we can pause it whole
let done = false;
let paused = false;
let pausedAt = 0;
let idleSince = Date.now();
const signalGroup = (sig) => {
  try {
    process.kill(-child.pid, sig);
  } catch {
    /* already gone */
  }
};
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    if (paused) signalGroup("SIGCONT"); // a stopped group can't act on SIGTERM
    signalGroup(sig);
  });
}
const exited = new Promise((resolve) => child.on("close", (code, signal) => resolve(code ?? (signal ? 128 : 1))));
exited.then(() => (done = true));

while (!done) {
  await Promise.race([sleep(POLL_MS), exited]);
  if (done) break;
  const busy = await comfyBusy();
  if (busy) idleSince = null;
  else idleSince ??= Date.now();
  if (busy && !paused) {
    paused = true;
    pausedAt = Date.now();
    signalGroup("SIGSTOP");
    say("ComfyUI started rendering: agent paused, model will be unloaded");
    await unloadModels();
  } else if (paused && idleSince && Date.now() - idleSince >= IDLE_S * 1000) {
    paused = false;
    signalGroup("SIGCONT");
    say(`ComfyUI is idle again: agent resumed after ${Math.round((Date.now() - pausedAt) / 1000)} s`);
  } else if (paused && Date.now() - pausedAt > PAUSE_MAX_S * 1000) {
    say(`paused for over ${Math.round(PAUSE_MAX_S / 60)} min: stopping this run`);
    signalGroup("SIGCONT");
    signalGroup("SIGTERM");
    await Promise.race([exited, sleep(15000)]);
    await unloadModels();
    process.exit(75);
  }
}

const code = await exited;
await unloadModels();
process.exit(code);
