import { useEffect, useState } from "react";
import { agentLabel } from "../agents";
import { createSchedule, deleteSchedule, getSchedules, setScheduleEnabled, type Schedule, type SourceCheck } from "../api";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

function describe(s: Schedule): string {
  const [m, h, , , dow] = s.cron.split(/\s+/);
  const time = /^\d+$/.test(m) && h.split(',').every((x)=>/^\d+$/.test(x)) ? h.split(',').map((x)=>`${x.padStart(2,"0")}:${m.padStart(2,"0")}`).join(' & ') : s.cron;
  const days = dow === "*" ? "every day" : dow === "1-5" ? "weekdays" : dow.split(",").map((d) => DAYS[+d] ?? d).join(", ");
  return `${days} at ${time} (${s.tz})`;
}

/** Recurring runs: e.g. weekdays 08:00 "Gemini: work 4 jobs", or a daily Telegram digest. */
export default function Schedules({ agents }: { agents: string[] }) {
  const [list, setList] = useState<Schedule[]>([]);
  const [checks, setChecks] = useState<SourceCheck[]>([]);
  const [kind, setKind] = useState<"queue" | "prompt" | "digest" | "sourcing">("queue");
  const [agent, setAgent] = useState("");
  const [count, setCount] = useState(4);
  const [copies, setCopies] = useState(1);
  const [prompt, setPrompt] = useState("");
  const [time, setTime] = useState("08:00");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [tz, setTz] = useState(localTz);
  const [jitter, setJitter] = useState(20);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => getSchedules().then((r) => {setList(r.schedules);setChecks(r.sourceChecks ?? []);}).catch((e: Error) => setMsg(e.message));
  useEffect(() => { void load(); const timer=setInterval(()=>document.visibilityState==='visible'&&void load(),15000);return()=>clearInterval(timer); }, []);
  useEffect(() => { if (!agent && agents.length) setAgent(agents[0]); }, [agents, agent]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const [h, m] = time.split(":").map(Number);
    const dow = days.length === 7 || days.length === 0 ? "*" : [...days].sort().join(",");
    try {
      const hours=kind==='sourcing'?`${h},${(Number(h)+12)%24}`:h;
      await createSchedule({ kind, agent: kind === "digest" || kind === "sourcing" ? undefined : agent, count, copies, prompt, cron: `${m} ${hours} * * ${dow}`, tz, jitterMin: jitter } as Partial<Schedule>);
      setMsg("Schedule added.");
      void load();
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  return (
    <section className="card wide">
      <div className="card-head">
        <h2>Schedules</h2>
        <span className="muted small">checked every ~30 s while a runner is online</span>
      </div>
      {list.length > 0 && (
        <ul className="sched-list">
          {list.map((s) => (
            <li key={s.id} className={s.enabled ? "" : "off"}>
              <div>
                <b>{s.kind === "digest" ? "📊 Daily digest" : s.kind === 'sourcing' ? 'Sourcing check · any available enabled agent' : `${agentLabel(s.agent)}: ${s.kind === "queue" ? `work ${s.count} jobs` : "custom prompt"}${s.copies > 1 ? ` ×${s.copies}` : ""}`}</b>
                <div className="muted small">
                  {describe(s)}{s.jitterMin ? ` +0–${s.jitterMin} min` : ""} · next {s.enabled && s.nextRunAt ? new Date(s.nextRunAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "—"}
                </div>
              </div>
              <div className="row-actions">
                <button className="ghost small-btn" onClick={() => void setScheduleEnabled(s.id, !s.enabled).then(load)}>{s.enabled ? "Pause" : "Resume"}</button>
                <button className="ghost small-btn danger" onClick={() => window.confirm(`Delete "${s.name}"?`) && void deleteSchedule(s.id).then(load)}>Delete</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {!!checks.length && <div className="source-checks"><h3>Recent sourcing checks</h3><ul>{checks.slice(0,4).map((c)=><li key={c.id}>{new Date(c.due_at).toLocaleString()} · <b>{c.status}</b> · {c.detail ?? 'Waiting for an available sourcing agent'}{c.run_id ? ` · run #${c.run_id}` : ''}</li>)}</ul></div>}
      <form className="sched-form" onSubmit={(e) => void add(e)}>
        <div className="seg" role="group" aria-label="Schedule type">
          {(["queue", "prompt", "digest", "sourcing"] as const).map((k) => (
            <button type="button" key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
              {k === "queue" ? "Work the queue" : k === "prompt" ? "Custom prompt" : k === "sourcing" ? "Source with backups" : "Telegram digest"}
            </button>
          ))}
        </div>
        {kind !== "digest" && kind !== "sourcing" && (
          <label>
            Agent
            <select value={agent} onChange={(e) => setAgent(e.target.value)}>
              {agents.map((a) => <option key={a} value={a}>{agentLabel(a)}</option>)}
            </select>
          </label>
        )}
        {kind === "queue" && (
          <label>Jobs per run <input className="num-in" type="number" min={1} max={10} value={count} onChange={(e) => setCount(+e.target.value)} /></label>
        )}
        {kind === "prompt" && (
          <label className="full">Prompt <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. Find 8 new remote AI engineering roles on Ashby and add_job them" /></label>
        )}
        {kind !== "digest" && kind !== "sourcing" && (
          <label>Parallel <input className="num-in" type="number" min={1} max={5} value={copies} onChange={(e) => setCopies(+e.target.value)} /></label>
        )}
        <label>{kind==='sourcing'?'First check':'Time'} <input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>
        {kind==='sourcing'&&<p className="small muted">A second sourcing check runs 12 hours later. An available enabled agent handles each check, with automatic backups.</p>}
        <div className="days" role="group" aria-label="Days">
          {DAYS.map((d, i) => (
            <button type="button" key={d} className={days.includes(i) ? "on" : ""} onClick={() => setDays(days.includes(i) ? days.filter((x) => x !== i) : [...days, i])}>{d}</button>
          ))}
        </div>
        <label>Time zone <input value={tz} onChange={(e) => setTz(e.target.value)} /></label>
        {kind!=='sourcing'&&<label>Random delay (min) <input className="num-in" type="number" min={0} max={120} value={jitter} onChange={(e) => setJitter(+e.target.value)} /></label>}
        <button disabled={kind === "prompt" && !prompt.trim()}>Add schedule</button>
      </form>
      {msg && <p className="small muted">{msg}</p>}
    </section>
  );
}
