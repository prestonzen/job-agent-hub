import { useEffect, useState } from "react";
import { getHub, getText } from "../api";

const DEFAULT_AGENTS = ["claude", "codex", "gemini", "kimi", "mistral", "ollama"];

function Snippet({ title, hint, code }: { title: string; hint?: React.ReactNode; code: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <section className="card snippet">
      <div className="card-head">
        <h2>{title}</h2>
        <button className="ghost" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {hint && <p className="muted small">{hint}</p>}
      <pre>
        <code>{code}</code>
      </pre>
    </section>
  );
}

/**
 * Setup for every kind of agent client. Tokens are never shown here: they live only in the
 * AGENT_TOKENS secret and in your local copy, so snippets use a placeholder.
 */
export default function Connect() {
  const [agents, setAgents] = useState<string[]>(DEFAULT_AGENTS);
  const [agent, setAgent] = useState("claude");
  const [mcpPrompt, setMcpPrompt] = useState("");
  const [restPrompt, setRestPrompt] = useState("");
  const origin = window.location.origin;
  const mcpUrl = `${origin}/mcp`;
  const tok = `<${agent} token>`;

  useEffect(() => {
    getHub()
      .then((h) => h.agents.length && setAgents([...new Set([...h.agents, ...DEFAULT_AGENTS])]))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const q = `agent=${encodeURIComponent(agent)}`;
    getText(`/api/admin/instructions?${q}&mode=mcp`).then(setMcpPrompt).catch(() => setMcpPrompt(""));
    getText(`/api/admin/instructions?${q}&mode=rest`).then(setRestPrompt).catch(() => setRestPrompt(""));
  }, [agent]);

  return (
    <>
      <section className="card">
        <h2>One hub, every agent</h2>
        <p>
          Every agent uses the same queue through its own token. MCP clients connect to <code>{mcpUrl}</code>. Anything else
          (browser agents, chat apps without MCP) uses the REST API at <code>{origin}/api/agent/*</code>. The token decides who
          the agent is, so give each agent its own.
        </p>
        <label className="inline">
          Agent{" "}
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            {agents.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </label>
        <p className="muted small">
          Agents without a token in <code>AGENT_TOKENS</code> get 401. Add one with{" "}
          <code>npx wrangler pages secret put AGENT_TOKENS --project-name job-agent-hub</code> (JSON of name → token). New names
          also need a matching “Applied By” option in ClickUp so their applications are tagged.
        </p>
      </section>

      <div className="grid two">
        <Snippet
          title="Claude Code"
          hint="Run once in a terminal. Then ask Claude to “work the Job Agent Hub queue”."
          code={`claude mcp add --transport http jobhunter ${mcpUrl} \\\n  --header "Authorization: Bearer ${tok}"`}
        />
        <Snippet
          title="Codex CLI"
          hint={
            <>
              Add to <code>~/.codex/config.toml</code> and set <code>JOBHUNTER_TOKEN</code> in your shell.
            </>
          }
          code={`[mcp_servers.jobhunter]\nurl = "${mcpUrl}"\nbearer_token_env_var = "JOBHUNTER_TOKEN"`}
        />
        <Snippet
          title="Gemini CLI"
          hint={
            <>
              Merge into <code>~/.gemini/settings.json</code>.
            </>
          }
          code={JSON.stringify({ mcpServers: { jobhunter: { httpUrl: mcpUrl, headers: { Authorization: `Bearer ${tok}` } } } }, null, 2)}
        />
        <Snippet
          title="Other MCP clients (Kimi CLI, Cursor, …)"
          hint="Most clients accept this mcpServers JSON. Remote MCP over HTTP with a bearer header."
          code={JSON.stringify(
            { mcpServers: { jobhunter: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${tok}` } } } },
            null,
            2,
          )}
        />
      </div>

      <Snippet
        title="Runner prompt for MCP agents"
        hint="MCP clients receive this as server instructions, but not every client shows it to the model. Paste it as the first message to be sure."
        code={mcpPrompt || "Loading…"}
      />
      <Snippet
        title="Runner prompt for REST agents (browser agents, Le Chat, Kimi web, ChatGPT)"
        hint="For agents that can make HTTP requests but can't add an MCP server. Replace the token placeholder before pasting."
        code={restPrompt ? `${restPrompt}\n\nYour token: ${tok}` : "Loading…"}
      />
    </>
  );
}
