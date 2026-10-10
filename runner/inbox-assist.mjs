#!/usr/bin/env node
// Job Agent Hub runner helper: pick up an emailed verification code from the applicant inbox
// (read-only OAuth) and print it as JSON. Zero dependencies (Node 22+). Credentials come from
// /etc/job-agent-runner/config.json (gmail.clientId / gmail.clientSecret / gmail.refreshToken)
// or the env vars GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN. Never hard-code secrets here.
//
// Usage:
//   node inbox-assist.mjs [--query 'gmail search'] [--wait 90] [--pattern '<regex with a capture group>']
//                         [--max-age-min 15] [--mark-read]
//
// Exit code 0 + JSON on stdout when a code was found; exit 1 + {ok:false,...} otherwise.
import { readFileSync } from "node:fs";

const HELP = `inbox-assist.mjs — pick up an emailed verification code from the applicant inbox

  --query <q>          Gmail search query (default: {from:greenhouse.io from:greenhouse-mail.io}
                       newer_than:10m — Greenhouse security codes come from
                       no-reply@us.greenhouse-mail.io)
  --wait <sec>         keep polling until a code arrives (default 90)
  --every <sec>        poll interval (default 5)
  --pattern <regex>    code matcher; first capture group is the code (default: 6-10 char
                       alphanumeric, e.g. a 6-digit OTP or a Greenhouse 8-char security code)
  --max-age-min <n>    ignore messages older than this (default 15)
  --mark-read          remove the INBOX label after reading (default: leave everything untouched)
  --config <path>      config file (default /etc/job-agent-runner/config.json)
  -h, --help           this text

Config (/etc/job-agent-runner/config.json) or env:
  { "gmail": { "clientId": "...", "clientSecret": "...", "refreshToken": "..." } }
  GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN

Getting a refresh token (one time): Google Cloud console → OAuth client (Web) →
https://developers.google.com/oauthplayground with scope https://www.googleapis.com/auth/gmail.readonly
→ "Exchange authorization code for tokens" → copy the refresh token.

Output (stdout, JSON): { ok, code, from, subject, date, snippet, waitedMs }
Then type/paste the code into the form field within its validity window (usually a few minutes).`;

function parseArgs(argv) {
  const a = { query: null, wait: 90, every: 5, pattern: null, maxAgeMin: 15, markRead: false, config: process.env.RUNNER_CONFIG ?? "/etc/job-agent-runner/config.json" };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "-h" || k === "--help") { console.log(HELP); process.exit(0); }
    const next = () => argv[++i];
    if (k === "--query") a.query = next();
    else if (k === "--wait") a.wait = parseInt(next(), 10);
    else if (k === "--every") a.every = parseInt(next(), 10);
    else if (k === "--pattern") a.pattern = next();
    else if (k === "--max-age-min") a.maxAgeMin = parseInt(next(), 10);
    else if (k === "--mark-read") a.markRead = true;
    else if (k === "--config") a.config = next();
    else { console.error(`unknown argument: ${k}`); process.exit(2); }
  }
  return a;
}

const loadConfig = (path) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (obj) => console.log(JSON.stringify(obj));
const fail = (error, extra = {}) => { out({ ok: false, error, ...extra }); process.exit(1); };

// node:https instead of fetch: undici (fetch) connection-hangs on this runner's dual-stack
// network for the agent user, while the https module connects fine.
import https from "node:https";
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

let cachedToken = null;
async function accessToken(cfg) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const clientId = process.env.GMAIL_CLIENT_ID ?? cfg.gmail?.clientId;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET ?? cfg.gmail?.clientSecret;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN ?? cfg.gmail?.refreshToken;
  if (!clientId || !clientSecret || !refreshToken) fail("missing gmail oauth credentials: set gmail.clientId/clientSecret/refreshToken in config or GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET/GMAIL_REFRESH_TOKEN");
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }).toString();
  const res = await req("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) fail(`token refresh failed: ${res.status} ${json.error_description ?? json.error ?? ""}`.trim());
  cachedToken = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return cachedToken.value;
}

async function gmail(path, cfg) {
  const token = await accessToken(cfg);
  const res = await req(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) fail(`gmail api ${path.split("?")[0]}: ${res.status} ${json.error?.message ?? ""}`.trim());
  return json;
}

async function gmailModify(messageId, body, cfg) {
  const token = await accessToken(cfg);
  const res = await req(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`gmail modify ${messageId}: ${res.status}`);
}

// Score candidates and return the best one. Codes are 6-10 char alphanumeric tokens that look
// non-prose: contain a digit, are ALL-CAPS, or are mixed-case (real Greenhouse security codes are
// mixed-case 8-char, e.g. "sQfL6JbK" — never change case, they may be case-sensitive). HTML tags
// (with their style attributes) are stripped first so color hexes like F9FAF9 don't compete.
const DEFAULT_PATTERN = "\\b([A-Za-z0-9]{6,10})\\b";
function extractCode(text, patternSrc) {
  const clean = text.replace(/<[^>]*>/g, " ").replace(/&[a-z]+;/gi, " ");
  const re = new RegExp(patternSrc, "g");
  const seen = new Set();
  let best = null;
  for (const m of clean.matchAll(re)) {
    const code = m[1] ?? m[0];
    if (seen.has(code)) continue;
    seen.add(code);
    const plausible = /\d/.test(code) || /^[A-Z0-9]+$/.test(code) || (/[a-z]/.test(code) && /[A-Z]/.test(code));
    if (!plausible) continue;
    const around = clean.slice(Math.max(0, m.index - 60), m.index + 60).toLowerCase();
    const score =
      (/code|verif|otp|confirm|pin|token|pass|security/.test(around) ? 10 : 0) +
      (/expire|valid|minutes|resubmit/.test(around) ? 2 : 0) +
      (/^\d{6}$/.test(code) ? 1 : 0) +
      (code.length === 8 ? 1 : 0);
    if (!best || score > best.score) best = { code, score };
  }
  return best;
}

async function findCode(cfg, args) {
  const list = await gmail(`/messages?q=${encodeURIComponent(args.query)}&maxResults=10`, cfg);
  const cutoff = Date.now() - args.maxAgeMin * 60_000;
  for (const ref of list.messages ?? []) {
    const msg = await gmail(`/messages/${ref.id}?format=full`, cfg);
    const headers = Object.fromEntries((msg.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));
    const date = Date.parse(headers.date ?? "");
    if (!Number.isNaN(date) && date < cutoff) continue; // stale code, skip
    const snippet = msg.snippet ?? "";
    let body = "";
    const walk = (p) => {
      if (!p) return;
      if (p.body?.data) body += Buffer.from(p.body.data, "base64url").toString("utf8") + "\n";
      (p.parts ?? []).forEach(walk);
    };
    walk(msg.payload);
    const haystack = `${headers.subject ?? ""}\n${snippet}\n${body}`;
    const hit = extractCode(haystack, args.pattern ?? DEFAULT_PATTERN);
    if (hit) return { code: hit.code, from: headers.from ?? null, subject: headers.subject ?? null, date: headers.date ?? null, snippet: snippet.slice(0, 160), messageId: ref.id };
  }
  return null;
}

const args = parseArgs(process.argv);
const cfg = loadConfig(args.config);
const query = args.query ?? cfg.gmail?.query ?? "{from:greenhouse.io from:greenhouse-mail.io} newer_than:10m";

const started = Date.now();
const deadline = started + args.wait * 1000;
for (;;) {
  try {
    const found = await findCode(cfg, args);
    if (found) {
      if (args.markRead && found.messageId) {
        try { await gmailModify(found.messageId, { removeLabelIds: ["INBOX"] }, cfg); } catch { /* best effort */ }
      }
      out({ ok: true, ...found, query, waitedMs: Date.now() - started });
      process.exit(0);
    }
  } catch (e) {
    if (e?.message?.startsWith("missing gmail") || e?.message?.startsWith("token refresh failed")) fail(e.message);
    console.error(`poll error: ${e.message}`); // network blip: keep polling
  }
  if (Date.now() > deadline) fail(`no code found within ${args.wait}s`, { query });
  await sleep(Math.max(2, args.every) * 1000);
}
