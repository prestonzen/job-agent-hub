#!/usr/bin/env node
// Writes each agent CLI's MCP config (hub + browser) for the current user, from the runner config.
// Run as the `agent` user: node configure-agents.mjs /etc/job-agent-runner/config.json
// Formats were read from each CLI's own schema (Oct 2026): Claude `mcp add-json`, Codex config.toml,
// Gemini/Qwen settings.json (httpUrl), Kimi Code ~/.kimi-code/mcp.json, Mistral Vibe [[mcp_servers]].
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const cfg = JSON.parse(readFileSync(process.argv[2] ?? "/etc/job-agent-runner/config.json", "utf8"));
const MCP_URL = `${cfg.hub}/mcp`;
const tokens = cfg.agentTokens ?? {};
// --image-responses omit: the accessibility snapshot is enough for forms, and screenshots cost many tokens per step.
// Persistent per-agent browser profile (never --isolated): a fresh blank profile every run looks like a bot
// farm to Cloudflare/Greenhouse. Cookies and session continuity accumulate per agent instead. Proxy,
// timezone, and AutomationControlled hardening live in pw-config.json on the runner (see docs/ANTI-DETECTION.md).
const PROFILE_ROOT = "/var/lib/job-agent-runner/profiles";
const PW_CONFIG = "/opt/job-agent-runner/pw-config.json";
// Real-user screen geometries, one per agent, stable per agent (a returning user keeps the same
// machine). A fleet that all reports the Playwright default 1280x720 viewport is a bot-farm tell;
// ten distinct, common desktop resolutions blended with per-agent profiles is not. The per-agent
// config copy lives inside the agent's own profile dir so the agent user can write it.
const VIEWPORTS = {
  claude:   { width: 1920, height: 1080 }, // most common desktop resolution worldwide
  claude2:  { width: 1680, height: 1050 },
  claude3:  { width: 1728, height: 1117 }, // 16" MacBook Pro logical resolution
  codex:    { width: 1536, height: 864 },  // classic 1080p laptop at 125% scaling
  kimi:     { width: 1440, height: 900 },
  kimi2:    { width: 1600, height: 900 },
  gemini:   { width: 1366, height: 768 },  // most common laptop panel ever shipped
  mistral:  { width: 2560, height: 1440 },
  qwen:     { width: 1280, height: 800 },
  deepseek: { width: 1920, height: 1200 },
  ollama:   { width: 1512, height: 982 },  // 14" MacBook Pro logical resolution
};
const pwConfigFor = (agent) => {
  const base = JSON.parse(readFileSync(PW_CONFIG, "utf8"));
  // Unknown future agents pick deterministically from the pool (name hash) so no two collide silently.
  const pool = Object.values(VIEWPORTS);
  const hash = [...agent].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const vp = VIEWPORTS[agent] ?? pool[hash % pool.length];
  base.browser = base.browser ?? {};
  base.browser.contextOptions = {
    ...(base.browser.contextOptions ?? {}),
    viewport: vp,
    screen: vp,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  };
  // WebGL renderer normalization is NOT done here: branded Google Chrome ignores
  // --load-extension entirely, so the spoof ships as a force-installed extension via
  // ExtensionInstallForcelist policy (runner/webgl-spoof/install-webgl-spoof.sh).
  const p = `${PROFILE_ROOT}/${agent}/pw-config.json`;
  mkdirSync(dirname(p), { recursive: true }); // first run of a newly added agent
  writeFileSync(p, JSON.stringify(base, null, 2));
  return p;
};
const browserFor = (agent) => ({
  command: "playwright-mcp",
  args: ["--user-data-dir", `${PROFILE_ROOT}/${agent}`, "--config", pwConfigFor(agent), "--browser", "chrome", "--image-responses", "omit", "--output-dir", ".playwright"],
});
const H = homedir();

const write = (p, s) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, s, { mode: 0o600 });
  console.log("wrote", p);
};
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {});
const bearer = (agent) => {
  if (!tokens[agent]) throw new Error(`no hub token for ${agent} in config.agentTokens`);
  return `Bearer ${tokens[agent]}`;
};
const toml = (s) => JSON.stringify(s); // TOML basic strings accept JSON string escapes

// Claude Code: user-scoped servers via its own CLI (keeps ~/.claude.json consistent).
if (tokens.claude) {
  for (const [name, def] of [
    ["jobhunter", { type: "http", url: MCP_URL, headers: { Authorization: bearer("claude") } }],
    ["playwright", { type: "stdio", ...browserFor("claude") }],
  ]) {
    spawnSync("claude", ["mcp", "remove", "-s", "user", name], { stdio: "ignore" });
    const r = spawnSync("claude", ["mcp", "add-json", "-s", "user", name, JSON.stringify(def)], { encoding: "utf8" });
    console.log(`claude mcp ${name}:`, r.status === 0 ? "ok" : (r.stderr || r.stdout).trim());
  }
}

// Extra Claude accounts for parallel capacity: the same Claude Code CLI with its own CLAUDE_CONFIG_DIR
// and its own login (claude2 = Preston's runner account, claude3 = Roman's API key), so they never clobber each other.
for (const [agent, dir] of [["claude2", ".claude-2"], ["claude3", ".claude-3"]]) {
  if (!tokens[agent]) continue;
  const home = join(H, dir);
  mkdirSync(home, { recursive: true });
  for (const [name, def] of [
    ["jobhunter", { type: "http", url: MCP_URL, headers: { Authorization: bearer(agent) } }],
    ["playwright", { type: "stdio", ...browserFor(agent) }],
  ]) {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: home };
    spawnSync("claude", ["mcp", "remove", "-s", "user", name], { stdio: "ignore", env });
    const r = spawnSync("claude", ["mcp", "add-json", "-s", "user", name, JSON.stringify(def)], { encoding: "utf8", env });
    console.log(`${agent} mcp ${name}:`, r.status === 0 ? "ok" : (r.stderr || r.stdout).trim());
  }
}

// Ollama (local GPU): driven by Hermes Agent (Nous Research), which keeps its own memory and writes reusable skills
// from the tasks it completes. Config goes in ~/.hermes via `hermes config set`; the hub token lives in ~/.hermes/.env.
if (tokens.ollama) {
  const hermesBin = [join(H, ".local", "bin", "hermes")].find((p) => existsSync(p)) ?? "hermes";
  const o = cfg.agents?.ollama?.hermes ?? {};
  const ctx = o.numCtx ?? 65536; // Hermes refuses models with less than 64k of context
  const set = (key, value) => {
    const r = spawnSync(hermesBin, ["config", "set", "--force", key, typeof value === "string" ? value : JSON.stringify(value)], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(H, ".local", "bin")}:${process.env.PATH}` },
    });
    if (r.status !== 0) console.log(`hermes config set ${key}:`, (r.stderr || r.stdout || "failed").trim().split("\n").pop());
  };
  set("model.default", o.model ?? "gemma4:26b");
  set("model.provider", "local-ollama");
  set("model.base_url", `${o.ollamaUrl ?? "http://127.0.0.1:11434"}/v1`);
  set("model.context_length", String(ctx));
  set("model.ollama_num_ctx", String(ctx));
  set("compression.threshold", String(o.compressionThreshold ?? 0.8));
  set("compression.protect_last_n", String(o.protectLastTurns ?? 8));
  set("providers.local-ollama.base_url", `${o.ollamaUrl ?? "http://127.0.0.1:11434"}/v1`);
  set("providers.local-ollama.api_key", "ollama");
  set("mcp_servers.jobhunter.url", MCP_URL);
  set("mcp_servers.jobhunter.headers.Authorization", "Bearer ${JOBHUNTER_TOKEN}");
  set("mcp_servers.jobhunter.connect_timeout", "60");
  set("mcp_servers.jobhunter.timeout", "120");
  set("mcp_servers.playwright.command", browserFor("ollama").command);
  set("mcp_servers.playwright.args", browserFor("ollama").args);
  set("mcp_servers.playwright.env.PLAYWRIGHT_BROWSERS_PATH", "/opt/ms-playwright");
  set("mcp_servers.playwright.env.DISPLAY", process.env.DISPLAY || ":99");
  const envPath = join(H, ".hermes", ".env");
  const kept = existsSync(envPath) ? readFileSync(envPath, "utf8").split("\n").filter((l) => l && !l.startsWith("JOBHUNTER_TOKEN=")) : [];
  write(envPath, [...kept, `JOBHUNTER_TOKEN=${tokens.ollama}`].join("\n") + "\n");
}

// DeepSeek has no CLI of its own: it runs through Claude Code pointed at DeepSeek's Anthropic-compatible endpoint
// (see the runner config). A separate CLAUDE_CONFIG_DIR keeps its MCP config and history apart from Claude's.
if (tokens.deepseek) {
  const dir = join(H, ".claude-deepseek");
  mkdirSync(dir, { recursive: true });
  for (const [name, def] of [
    ["jobhunter", { type: "http", url: MCP_URL, headers: { Authorization: bearer("deepseek") } }],
    ["playwright", { type: "stdio", ...browserFor("deepseek") }],
  ]) {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
    spawnSync("claude", ["mcp", "remove", "-s", "user", name], { stdio: "ignore", env });
    const r = spawnSync("claude", ["mcp", "add-json", "-s", "user", name, JSON.stringify(def)], { encoding: "utf8", env });
    console.log(`deepseek (claude) mcp ${name}:`, r.status === 0 ? "ok" : (r.stderr || r.stdout).trim());
  }
}

// Codex: token comes from $JOBHUNTER_TOKEN, which the runner sets per agent.
if (tokens.codex) {
  write(
    join(H, ".codex", "config.toml"),
    [
      "# Managed by job-agent-hub runner/configure-agents.mjs",
      "[mcp_servers.jobhunter]",
      `url = ${toml(MCP_URL)}`,
      'bearer_token_env_var = "JOBHUNTER_TOKEN"',
      "",
      "[mcp_servers.playwright]",
      `command = ${toml(browserFor("codex").command)}`,
      `args = [${browserFor("codex").args.map(toml).join(", ")}]`,
      "",
    ].join("\n"),
  );
}

// Gemini CLI and Qwen Code (a Gemini CLI fork): settings.json, merged with what's there.
for (const [agent, dir] of [["gemini", ".gemini"], ["qwen", ".qwen"]]) {
  if (!tokens[agent]) continue;
  const p = join(H, dir, "settings.json");
  const s = readJson(p);
  s.mcpServers = {
    ...(s.mcpServers ?? {}),
    // Default connect timeout is too short over a high-latency home/mobile uplink.
    jobhunter: { httpUrl: MCP_URL, headers: { Authorization: bearer(agent) }, timeout: 30000 },
    playwright: browserFor(agent),
  };
  // With GEMINI_API_KEY in ~/.gemini/.env (Gemini only), run headless on the API key instead of Google login.
  if (agent === "gemini" && existsSync(join(H, ".gemini", ".env")) && /GEMINI_API_KEY=\S+/.test(readFileSync(join(H, ".gemini", ".env"), "utf8"))) {
    s.security = { ...(s.security ?? {}), auth: { ...(s.security?.auth ?? {}), selectedType: "gemini-api-key" } };
  }
  write(p, JSON.stringify(s, null, 2) + "\n");
  // Gemini-family CLIs disable MCP servers in untrusted folders; each run gets a fresh dir under workDir.
  const tf = join(H, dir, "trustedFolders.json");
  const trusted = readJson(tf);
  trusted[cfg.workDir ?? "/var/lib/job-agent-runner/runs"] = "TRUST_FOLDER";
  write(tf, JSON.stringify(trusted, null, 2) + "\n");
}

// Kimi Code: ~/.kimi-code/mcp.json; token from $JOBHUNTER_TOKEN.
if (tokens.kimi) {
  const p = join(H, ".kimi-code", "mcp.json");
  const s = readJson(p);
  s.mcpServers = {
    ...(s.mcpServers ?? {}),
    // Generous startup/tool timeouts: the hub connection fails ("fetch failed") with the defaults over this uplink.
    jobhunter: { transport: "http", url: MCP_URL, bearerTokenEnvVar: "JOBHUNTER_TOKEN", startupTimeoutMs: 60000, toolTimeoutMs: 120000 },
    playwright: { transport: "stdio", ...browserFor("kimi") },
  };
  write(p, JSON.stringify(s, null, 2) + "\n");
}

// Kimi Code second account: its own HOME (~/.kimi2-home) so it keeps a separate login and config.
if (tokens.kimi2) {
  const p = join(H, ".kimi2-home", ".kimi-code", "mcp.json");
  const s = readJson(p);
  s.mcpServers = {
    ...(s.mcpServers ?? {}),
    jobhunter: { transport: "http", url: MCP_URL, bearerTokenEnvVar: "JOBHUNTER_TOKEN", startupTimeoutMs: 60000, toolTimeoutMs: 120000 },
    playwright: { transport: "stdio", ...browserFor("kimi2") },
  };
  write(p, JSON.stringify(s, null, 2) + "\n");
}

// Mistral Vibe: [[mcp_servers]] blocks in ~/.vibe/config.toml (our block is replaced on re-run).
if (tokens.mistral) {
  const p = join(H, ".vibe", "config.toml");
  const START = "# >>> job-agent-hub (managed)";
  const END = "# <<< job-agent-hub";
  const prev = existsSync(p) ? readFileSync(p, "utf8") : "";
  const kept = prev.replace(new RegExp(`${START}[\\s\\S]*?${END}\\n?`), "");
  const block = [
    START,
    "[[mcp_servers]]",
    'name = "jobhunter"',
    'transport = "streamable-http"',
    `url = ${toml(MCP_URL)}`,
    "[mcp_servers.auth]",
    'type = "static"',
    `headers = { Authorization = ${toml(bearer("mistral"))} }`,
    "",
    "[[mcp_servers]]",
    'name = "playwright"',
    'transport = "stdio"',
    `command = ${toml(browserFor("mistral").command)}`,
    `args = [${browserFor("mistral").args.map(toml).join(", ")}]`,
    END,
    "",
  ].join("\n");
  write(p, (kept.trimEnd() ? kept.trimEnd() + "\n\n" : "") + block);
}
