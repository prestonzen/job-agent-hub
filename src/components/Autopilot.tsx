import { useEffect, useState } from "react";
import { agentColor, agentLabel } from "../agents";
import { getAutopilot, saveAutopilot, type AgentAutopilot, type AutopilotSettings } from "../api";

const STATE: Record<AgentAutopilot["state"], { icon: string; text: string }> = {
  working: { icon: "🏃", text: "working" },
  queued: { icon: "⏳", text: "starting" },
  waiting: { icon: "⏱️", text: "resting" },
  ready: { icon: "🟢", text: "ready" },
  paused: { icon: "⚠️", text: "paused" },
  off: { icon: "⚪", text: "off" },
  "not-ready": { icon: "🔑", text: "needs login" },
};

const mins = (iso: string) => Math.max(1, Math.ceil((Date.parse(iso) - Date.now()) / 60_000));

/** Master switch: while Active, every logged-in agent applies on its own (no schedule needed). */
export default function Autopilot() {
  const [s, setS] = useState<AutopilotSettings | null>(null);
  const [agents, setAgents] = useState<AgentAutopilot[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const apply = (r: { settings: AutopilotSettings; agents: AgentAutopilot[] }) => {
    setS(r.settings);
    setAgents(r.agents);
    setErr(null);
  };
  const load = () => getAutopilot().then(apply).catch((e: Error) => setErr(e.message));
  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 10_000);
    return () => clearInterval(t);
  }, []);

  if (err && !s) return <p className="notice">Autopilot: {err}</p>;
  if (!s) return null;

  const patch = (p: Partial<AutopilotSettings>) => saveAutopilot(p).then(apply).catch((e: Error) => setErr(e.message));
  const working = agents.filter((a) => a.state === "working").length;

  return (
    <section className={`card autopilot ${s.enabled ? "active" : "disabled"}`}>
      <div className="ap-head">
        <button
          className={`ap-switch ${s.enabled ? "on" : ""}`}
          role="switch"
          aria-checked={s.enabled}
          aria-label="Autopilot"
          onClick={() => void patch({ enabled: !s.enabled })}
        >
          <span />
        </button>
        <div>
          <h2>
            Autopilot: <b>{s.enabled ? "ACTIVE" : "DISABLED"}</b>
          </h2>
          <p className="muted small">
            {s.enabled
              ? `Every logged-in agent keeps applying on its own${working ? ` · ${working} working right now` : ""}. Flip it off to stop starting new runs.`
              : "No new runs will start. Runs already in progress finish (use Run agents → Stop to end them)."}
          </p>
        </div>
        <button className="ghost small-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Hide settings" : "Settings"}
        </button>
      </div>

      <ul className="ap-agents">
        {agents.map((a) => (
          <li key={a.agent} className={`st-${a.state}`} title={a.detail ?? undefined}>
            <i className="key" style={{ background: agentColor(a.agent) }} aria-hidden="true" />
            <b>{agentLabel(a.agent)}</b>
            {a.role === "backlog" && <span className="chip" title="Works jobs other agents handed over (failures, essays), with their action log">backlog</span>}
            <span className="muted">
              {STATE[a.state].icon} {STATE[a.state].text}
              {a.state === "waiting" && a.nextAt ? ` · next in ${mins(a.nextAt)} min` : ""}
            </span>
            {a.state !== "not-ready" && (
              <button
                className="ghost small-btn"
                onClick={() => void patch({ agents: { [a.agent]: s.agents[a.agent] === false } })}
              >
                {s.agents[a.agent] === false ? "Turn on" : "Turn off"}
              </button>
            )}
          </li>
        ))}
      </ul>

      {open && (
        <div className="inline-fields">
          <label>
            Jobs per run <input className="num-in" type="number" min={1} max={10} defaultValue={s.jobsPerRun} onBlur={(e) => void patch({ jobsPerRun: +e.target.value })} />
          </label>
          <label>
            Rest between an agent's runs (min) <input className="num-in" type="number" min={5} max={720} defaultValue={s.minGapMin} onBlur={(e) => void patch({ minGapMin: +e.target.value })} />
          </label>
          <label>
            Runs at once <input className="num-in" type="number" min={1} max={6} defaultValue={s.maxConcurrent} onBlur={(e) => void patch({ maxConcurrent: +e.target.value })} />
          </label>
        </div>
      )}
      {err && <p className="small muted">{err}</p>}
    </section>
  );
}
