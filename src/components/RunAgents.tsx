import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentColor, agentLabel, sortAgents } from "../agents";
import { cancelRun, createRun, getRun, getRuns } from "../api";
import type { Run, RunnerInfo } from "../types";
import Schedules from "./Schedules";

const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
const dur = (a: string | null, b: string | null) => {
  if (!a) return "—";
  const s = Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

const STATUS_CLASS: Record<Run["status"], string> = {
  queued: "s-not-started",
  running: "live",
  succeeded: "",
  failed: "warn",
  cancelled: "s-not-started",
};

/** Launch agent runs on runner machines and watch their output live, from any device. */
export default function RunAgents() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [runners, setRunners] = useState<RunnerInfo[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await getRuns();
      setRuns(r.runs);
      setRunners(r.runners);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 4_000);
    return () => clearInterval(t);
  }, [load]);

  // Every agent CLI any online runner has, ready ones first.
  const agentOptions = useMemo(() => {
    const m = new Map<string, { ready: boolean; note: string | null }>();
    for (const r of runners.filter((x) => x.online)) {
      for (const a of r.agents) {
        const prev = m.get(a.id);
        if (!prev || (!prev.ready && a.ready)) m.set(a.id, { ready: a.ready, note: a.note ?? null });
      }
    }
    return sortAgents([...m.keys()]).map((id) => ({ id, ...m.get(id)! }));
  }, [runners]);

  const online = runners.filter((r) => r.online);

  return (
    <>
      {err && <p className="notice">Error: {err}</p>}

      <div className="grid two">
        <section className="card">
          <div className="card-head">
            <h2>Runners</h2>
          </div>
          {runners.length === 0 ? (
            <p className="muted">
              No runner has checked in yet. Install <code>runner/runner.mjs</code> on an always-on machine (see runner/README.md).
            </p>
          ) : (
            runners.map((r) => (
              <div key={r.name} className="runner">
                <div className="runner-head">
                  <span className={`pulse${r.online ? " on" : ""}`} aria-hidden="true" />
                  <b>{r.name}</b>
                  <span className="muted small">
                    {r.online ? `${r.busy}/${r.slots} busy` : `offline · last seen ${ago(r.lastSeen)}`}
                  </span>
                </div>
                <ul className="chips">
                  {sortAgents(r.agents.map((a) => a.id)).map((id) => {
                    const a = r.agents.find((x) => x.id === id)!;
                    return (
                      <li key={id} className={`chip${a.ready ? " ready" : ""}`} title={a.version ?? a.note ?? ""}>
                        <i className="key" style={{ background: agentColor(id) }} aria-hidden="true" />
                        {agentLabel(id)} <span className="muted">· {a.ready ? "ready" : a.note}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </section>

        <Launcher options={agentOptions} disabled={online.length === 0} onLaunched={(id) => { setSelected(id); void load(); }} />
      </div>

      <Schedules agents={agentOptions.map((o) => o.id)} />

      <section className="card wide runs-card">
        <div className="card-head">
          <h2>Runs</h2>
          <span className="muted small">refreshes every few seconds</span>
        </div>
        {runs.length === 0 ? (
          <p className="muted">No runs yet.</p>
        ) : (
          <ul className="runs">
            {runs.map((r) => (
              <li key={r.id} className={selected === r.id ? "on" : ""}>
                <button className="run-row" onClick={() => setSelected(selected === r.id ? null : r.id)} aria-expanded={selected === r.id}>
                  <span className="mono muted">#{r.id}</span>
                  <span className="who">
                    <i className="key" style={{ background: agentColor(r.agent) }} aria-hidden="true" />
                    {agentLabel(r.agent)}
                  </span>
                  <span className="task">{r.kind === "queue" ? `Work ${r.count} jobs` : (r.prompt ?? "").slice(0, 80)}</span>
                  <span className={`pill ${STATUS_CLASS[r.status]}`}>{r.cancel && r.status === "running" ? "stopping" : r.status}</span>
                  <span className="muted small nowrap">
                    {r.startedAt
                      ? dur(r.startedAt, r.finishedAt)
                      : r.notBefore && Date.parse(r.notBefore) > Date.now()
                        ? `starts ${new Date(r.notBefore).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                        : ago(r.createdAt)}
                  </span>
                </button>
                {selected === r.id && <RunLog run={r} onCancel={async () => { await cancelRun(r.id); void load(); }} />}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function Launcher({ options, disabled, onLaunched }: { options: { id: string; ready: boolean; note: string | null }[]; disabled: boolean; onLaunched: (id: number) => void }) {
  const [agent, setAgent] = useState("");
  const [kind, setKind] = useState<"queue" | "prompt">("queue");
  const [count, setCount] = useState(4);
  const [copies, setCopies] = useState(1);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!agent && options.length) setAgent((options.find((o) => o.ready) ?? options[0]).id);
  }, [options, agent]);

  const chosen = options.find((o) => o.id === agent);

  async function launch(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const { runs } = await createRun({ agent, kind, count, prompt, copies });
      setMsg(`Queued ${runs.length} run${runs.length > 1 ? "s" : ""}. A runner picks it up within a few seconds.`);
      onLaunched(runs[0].id);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card launcher" onSubmit={(e) => void launch(e)}>
      <div className="card-head">
        <h2>Launch</h2>
      </div>
      <label>
        Agent
        <select value={agent} onChange={(e) => setAgent(e.target.value)} disabled={!options.length}>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {agentLabel(o.id)}
              {o.ready ? "" : ` (${o.note ?? "not ready"})`}
            </option>
          ))}
        </select>
      </label>
      <div className="seg" role="group" aria-label="Task">
        <button type="button" className={kind === "queue" ? "on" : ""} onClick={() => setKind("queue")}>
          Work the queue
        </button>
        <button type="button" className={kind === "prompt" ? "on" : ""} onClick={() => setKind("prompt")}>
          Custom prompt
        </button>
      </div>
      {kind === "queue" ? (
        <label>
          Jobs per run <b>{count}</b>
          <input type="range" min={1} max={10} value={count} onChange={(e) => setCount(Number(e.target.value))} />
        </label>
      ) : (
        <label>
          Prompt
          <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. Find 5 new remote AI roles on Ashby and add_job them to the queue" />
        </label>
      )}
      <label>
        Parallel runs <b>{copies}</b>
        <input type="range" min={1} max={5} value={copies} onChange={(e) => setCopies(Number(e.target.value))} />
      </label>
      <button disabled={busy || disabled || !agent || (kind === "prompt" && !prompt.trim())}>
        {busy ? "Queuing…" : `Launch ${agentLabel(agent || "agent")}`}
      </button>
      {chosen && !chosen.ready && <p className="muted small">This agent isn't ready on any runner ({chosen.note}). The run will wait in the queue until it is.</p>}
      {disabled && <p className="muted small">No runner online.</p>}
      {msg && <p className="small">{msg}</p>}
    </form>
  );
}

function RunLog({ run, onCancel }: { run: Run; onCancel: () => void }) {
  const [log, setLog] = useState<string>("");
  const pre = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const live = run.status === "running" || run.status === "queued";

  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const r = await getRun(run.id);
        if (alive) setLog(r.log ?? "");
      } catch {
        /* keep last */
      }
    };
    void pull();
    if (!live) return () => { alive = false; };
    const t = setInterval(pull, 2_000);
    return () => { alive = false; clearInterval(t); };
  }, [run.id, live]);

  useEffect(() => {
    if (stick.current && pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [log]);

  return (
    <div className="run-log">
      <div className="run-log-bar">
        <span className="muted small">
          {run.runner ? `on ${run.runner}` : "waiting for a runner"} · {run.exitCode !== null ? `exit ${run.exitCode}` : live ? "live" : run.status}
        </span>
        {live && !run.cancel && (
          <button className="ghost small-btn danger" onClick={onCancel}>
            Stop
          </button>
        )}
      </div>
      <pre
        ref={pre}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {log || (run.status === "queued" ? "Queued…" : "No output yet.")}
      </pre>
    </div>
  );
}
