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
const BROWSER = { command: "playwright-mcp", args: ["--isolated", "--browser", "chromium", "--output-dir", ".playwright"] };
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
    ["playwright", { type: "stdio", ...BROWSER }],
  ]) {
    spawnSync("claude", ["mcp", "remove", "-s", "user", name], { stdio: "ignore" });
    const r = spawnSync("claude", ["mcp", "add-json", "-s", "user", name, JSON.stringify(def)], { encoding: "utf8" });
    console.log(`claude mcp ${name}:`, r.status === 0 ? "ok" : (r.stderr || r.stdout).trim());
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
      `command = ${toml(BROWSER.command)}`,
      `args = [${BROWSER.args.map(toml).join(", ")}]`,
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
    playwright: { command: BROWSER.command, args: BROWSER.args },
  };
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
    jobhunter: { transport: "http", url: MCP_URL, bearerTokenEnvVar: "JOBHUNTER_TOKEN" },
    playwright: { transport: "stdio", command: BROWSER.command, args: BROWSER.args },
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
    `command = ${toml(BROWSER.command)}`,
    `args = [${BROWSER.args.map(toml).join(", ")}]`,
    END,
    "",
  ].join("\n");
  write(p, (kept.trimEnd() ? kept.trimEnd() + "\n\n" : "") + block);
}
