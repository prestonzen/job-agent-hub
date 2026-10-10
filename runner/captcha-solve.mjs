#!/usr/bin/env node
// Job Agent Hub runner helper: solve a CAPTCHA/bot-check for a page and print the token as JSON.
// Zero dependencies (Node 22+). Paid solving service (2Captcha by default, CapSolver optional) —
// the API key comes from /etc/job-agent-runner/config.json (captcha.provider / captcha.apiKey)
// or the env vars CAPTCHA_PROVIDER / CAPTCHA_API_KEY. Never hard-code keys here.
//
// Usage:
//   node captcha-solve.mjs --url <page-url> [--sitekey <key>] [--type auto|turnstile|recaptcha-v2]
//                         [--attempts 3] [--timeout 240] [--proxy http://user:pass@host:port]
//
// Exit code 0 + JSON on stdout when a token was bought; exit 1 + {ok:false,...} otherwise.
// The JSON "inject" field tells the caller how to apply the token in the page (via the browser).
import { readFileSync } from "node:fs";
import https from "node:https";

// node:https instead of fetch: undici (fetch) connection-hangs on this runner's dual-stack
// network for the agent user, while the https module connects fine.
function req(url, { method = "GET", headers = {}, body = null, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers: { ...headers, ...(body != null ? { "Content-Length": Buffer.byteLength(body) } : {}) }, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => text, json: async () => JSON.parse(text) });
        });
      },
    );
    r.on("timeout", () => r.destroy(new Error(`request timeout after ${timeoutMs}ms`)));
    r.on("error", reject);
    if (body != null) r.write(body);
    r.end();
  });
}

const HELP = `captcha-solve.mjs — buy a CAPTCHA token for a page (2Captcha / CapSolver)

  --url <url>        page URL that shows the challenge (required)
  --sitekey <key>    challenge sitekey; if omitted it is scraped from the page HTML
  --type <t>         auto (default) | turnstile | recaptcha-v2
  --attempts <n>     solve attempts before giving up (default 3)
  --timeout <sec>    max seconds to wait for a solution (default 240)
  --proxy <url>      upstream proxy for the solving service (residential; Turnstile often needs one)
  --config <path>    config file (default /etc/job-agent-runner/config.json)
  -h, --help         this text

Config (/etc/job-agent-runner/config.json) or env:
  { "captcha": { "provider": "2captcha", "apiKey": "..." } }
  CAPTCHA_PROVIDER / CAPTCHA_API_KEY

Output (stdout, JSON): { ok, provider, type, sitekey, token, costCents, elapsedMs, inject }
Use the token with the browser (Playwright MCP) as described in "inject".`;

// ---------- tiny arg parser ----------
function parseArgs(argv) {
  const a = { attempts: 3, timeout: 240, type: "auto", sitekey: null, proxy: null, url: null, config: process.env.RUNNER_CONFIG ?? "/etc/job-agent-runner/config.json" };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "-h" || k === "--help") { console.log(HELP); process.exit(0); }
    const next = () => argv[++i];
    if (k === "--url") a.url = next();
    else if (k === "--sitekey") a.sitekey = next();
    else if (k === "--type") a.type = next();
    else if (k === "--attempts") a.attempts = parseInt(next(), 10);
    else if (k === "--timeout") a.timeout = parseInt(next(), 10);
    else if (k === "--proxy") a.proxy = next();
    else if (k === "--config") a.config = next();
    else { console.error(`unknown argument: ${k}`); process.exit(2); }
  }
  return a;
}

function loadConfig(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (obj) => console.log(JSON.stringify(obj));
const fail = (error, extra = {}) => { out({ ok: false, error, ...extra }); process.exit(1); };

// ---------- sitekey scraping ----------
async function fetchSitekey(url) {
  let html;
  try {
    const res = await req(url, { timeoutMs: 20_000, headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36" } });
    if (!res.ok) return { sitekey: null, kindHint: null };
    html = await res.text();
  } catch { return { sitekey: null, kindHint: null }; }
  const turnstile = html.match(/cf-turnstile[\s\S]{0,400}?data-sitekey=["']([^"']+)["']/i) ?? html.match(/data-sitekey=["']([^"']+)["'][\s\S]{0,400}?cf-turnstile/i) ?? html.match(/turnstile\.render\([^)]*?["']([^"']{10,})["']/i);
  const recaptcha = html.match(/g-recaptcha[\s\S]{0,300}?data-sitekey=["']([^"']+)["']/i) ?? html.match(/\/recaptcha\/api\.js\?render=explicit|grecaptcha\.render\([^)]*?["']([^"']{10,})["']/i);
  if (turnstile?.[1]) return { sitekey: turnstile[1], kindHint: "turnstile" };
  if (recaptcha?.[1] || recaptcha?.[2]) return { sitekey: recaptcha[1] ?? recaptcha[2], kindHint: "recaptcha-v2" };
  if (/cf-turnstile/i.test(html)) return { sitekey: null, kindHint: "turnstile" }; // invisible, no explicit key
  if (/recaptcha/i.test(html)) return { sitekey: null, kindHint: "recaptcha-v2" };
  return { sitekey: null, kindHint: null };
}

// ---------- provider clients ----------
async function solve2captcha({ apiKey, type, url, sitekey, proxy, timeoutSec }) {
  const params = new URLSearchParams({ key: apiKey, json: "1" });
  if (type === "turnstile") {
    params.set("method", "turnstile");
    params.set("websiteURL", url);
    if (sitekey) params.set("websiteKey", sitekey);
  } else {
    params.set("method", "userrecaptcha");
    params.set("googlekey", sitekey ?? "");
    params.set("pageurl", url);
  }
  if (proxy) params.set("proxy", proxy.replace(/^https?:\/\//, ""));
  const created = await (await req(`https://2captcha.com/in.php?${params}`)).json();
  if (created.status !== 1) return { error: `2captcha in.php: ${created.request}` };
  const id = created.request;
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    if (Date.now() > deadline) return { error: `timeout after ${timeoutSec}s waiting for solution (id ${id})` };
    await sleep(5_000);
    const r = await (await req(`https://2captcha.com/res.php?key=${apiKey}&action=get&id=${id}&json=1`)).json();
    if (r.status === 1) return { token: r.request, costCents: parseFloat(r.price ?? 0) * 100 };
    if (r.request !== "CAPCHA_NOT_READY") return { error: `2captcha res.php: ${r.request} (id ${id})` };
  }
}

async function solveCapsolver({ apiKey, type, url, sitekey, proxy, timeoutSec }) {
  const task = { websiteURL: url, websiteKey: sitekey ?? "" };
  let taskType;
  if (type === "turnstile") taskType = proxy ? "AntiTurnstileTask" : "AntiTurnstileTaskProxyLess";
  else taskType = proxy ? "RecaptchaV2Task" : "RecaptchaV2TaskProxyLess";
  if (proxy) task.proxy = proxy;
  const post = (body) => req("https://api.capsolver.com", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const created = await post({ clientKey: apiKey, task: { type: taskType, ...task } });
  if (created.errorId !== 0) return { error: `capsolver createTask: ${created.errorDescription ?? created.errorCode}` };
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    if (Date.now() > deadline) return { error: `timeout after ${timeoutSec}s waiting for solution (id ${created.taskId})` };
    await sleep(3_000);
    const r = await post({ clientKey: apiKey, taskId: created.taskId });
    if (r.errorId !== 0) return { error: `capsolver getTaskResult: ${r.errorDescription ?? r.errorCode}` };
    if (r.status === "ready") return { token: r.solution.token, costCents: Math.round((r.solution.price ?? 0) * 100) };
    if (r.status !== "processing") return { error: `capsolver unexpected status: ${r.status}` };
  }
}

const SOLVERS = { "2captcha": solve2captcha, capsolver: solveCapsolver };

function injectHint(type) {
  if (type === "turnstile") {
    return [
      "Turnstile token (valid ~5 min). Apply in the page via browser_evaluate, then submit:",
      '  const t = TOKEN; const el = document.querySelector("input[name=\\"cf-turnstile-response\\"]") || [...document.querySelectorAll("textarea")].find(e => e.name.includes("turnstile"));',
      '  if (el) { el.value = t; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }',
      '  Also try: window.turnstile?.getResponse ? null : document.querySelector("form")?.requestSubmit()',
      '  If a callback is registered (window.tsCallback / data-callback), call it with the token.',
    ].join("\n");
  }
  return [
    "reCAPTCHA v2 token (valid ~2 min). Apply in the page via browser_evaluate, then submit:",
    '  const t = TOKEN;',
    '  const el = document.getElementById("g-recaptcha-response");',
    '  if (el) { el.value = t; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }',
    "  If grecaptcha is on the page: grecaptcha.getResponse() should return t; then click submit.",
  ].join("\n");
}

// ---------- main ----------
const args = parseArgs(process.argv);
if (!args.url) { console.error("missing --url\n\n" + HELP); process.exit(2); }

const cfg = loadConfig(args.config);
const provider = (process.env.CAPTCHA_PROVIDER ?? cfg.captcha?.provider ?? "2captcha").toLowerCase();
const apiKey = process.env.CAPTCHA_API_KEY ?? cfg.captcha?.apiKey;
if (!apiKey) fail(`no captcha api key: set captcha.apiKey in ${args.config} or CAPTCHA_API_KEY`);
const solver = SOLVERS[provider];
if (!solver) fail(`unknown captcha provider "${provider}" (supported: ${Object.keys(SOLVERS).join(", ")})`);

let { sitekey, kindHint } = args.sitekey ? { sitekey: args.sitekey, kindHint: null } : await fetchSitekey(args.url);
const type = args.type !== "auto" ? args.type : (kindHint ?? "turnstile");
if (!sitekey && type !== "turnstile") fail("could not determine sitekey; pass --sitekey", { type });

let lastError = null;
for (let attempt = 1; attempt <= args.attempts; attempt++) {
  const started = Date.now();
  const r = await solver({ apiKey, type, url: args.url, sitekey, proxy: args.proxy, timeoutSec: Math.max(30, Math.floor(args.timeout / args.attempts)) });
  if (r.token) {
    out({ ok: true, provider, type, sitekey, token: r.token, costCents: r.costCents ?? null, elapsedMs: Date.now() - started, attempt, inject: injectHint(type) });
    process.exit(0);
  }
  lastError = r.error;
  if (attempt < args.attempts) await sleep(3_000);
}
fail(lastError ?? "all attempts failed", { provider, type, sitekey, attempts: args.attempts });
