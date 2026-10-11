import { useCallback, useEffect, useMemo, useState } from "react";
import { getAssisted, releaseJob, reportJob, type AssistedJob } from "../api";
import { agentColor, agentLabel } from "../agents";
import { Card } from "./Panels";

const PROMPT = `Work the assisted queue. Use GET /api/admin/assisted (admin token), take the jobs one at a time in my Chrome, read each job's attempt log first, finish the application, and report the result with POST /api/admin/jobs/<id>/report. Ask me when you need a code or a challenge solved.`;

function ago(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

export default function Assisted() {
  const [data, setData] = useState<{ jobs: AssistedJob[]; notWorkable: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cat, setCat] = useState("all");
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await getAssisted());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const cats = useMemo(() => {
    const m = new Map<string, number>();
    for (const j of data?.jobs ?? []) m.set(j.category, (m.get(j.category) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [data]);

  if (err && !data) return <p className="notice">Couldn't load the assisted queue: {err}</p>;
  if (!data) return <p className="notice">Loading…</p>;

  const shown = data.jobs.filter((j) => cat === "all" || j.category === cat);

  async function act(j: AssistedJob, fn: () => Promise<unknown>) {
    setBusy(j.id);
    try {
      await fn();
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Card title="Assisted queue" className="wide" aside={<span className="muted small">{data.jobs.length} to push through{data.notWorkable ? ` · ${data.notWorkable} not workable (eligibility, travel, already done)` : ""}</span>}>
        <p className="muted small">
          Jobs the agents couldn't finish: a second failure, a code or challenge, an account to sign in to. Work them in a real, signed-in Chrome with a person nearby. Each job carries the agents' attempt logs so nothing starts from zero.
        </p>
        <div className="assist-how">
          <b>Run it with Claude in Chrome</b>: open a Claude session with the Chrome extension and paste:
          <pre>{PROMPT}</pre>
          <button
            className="ghost small-btn"
            onClick={() => {
              void navigator.clipboard?.writeText(PROMPT).then(() => setCopied(true));
              setTimeout(() => setCopied(false), 2000);
            }}
          >
            {copied ? "Copied" : "Copy prompt"}
          </button>
        </div>
        {err && <p className="err">{err}</p>}
        <div className="seg" role="group" aria-label="Filter by blocker">
          <button className={cat === "all" ? "on" : ""} onClick={() => setCat("all")}>
            All {data.jobs.length}
          </button>
          {cats.map(([c, n]) => (
            <button key={c} className={cat === c ? "on" : ""} onClick={() => setCat(c)}>
              {c} {n}
            </button>
          ))}
        </div>
      </Card>

      <section className="card wide">
        {shown.length === 0 && <p className="muted">Nothing here. 🎉</p>}
        <ul className="assist-list">
          {shown.map((j) => (
            <li key={j.id}>
              <div className="assist-head">
                <div className="assist-title">
                  <a href={j.clickupUrl} target="_blank" rel="noreferrer">
                    {j.name}
                  </a>
                  <span className="sub">
                    {j.reason}
                    {j.pay ? ` · ${j.pay}` : ""}
                  </span>
                </div>
                <div className="assist-meta">
                  <span className="chip">{j.category}</span>
                  {j.ats && <span className="chip">{j.ats}</span>}
                  {j.fit !== null && <span className="chip">fit {j.fit}/5</span>}
                  {j.attempts.length > 0 && (
                    <button className="ghost small-btn" onClick={() => setOpen(open === j.id ? null : j.id)}>
                      {j.attempts.length} attempt{j.attempts.length === 1 ? "" : "s"}
                    </button>
                  )}
                </div>
              </div>
              {open === j.id && (
                <ol className="attempts">
                  {j.attempts.map((a, i) => (
                    <li key={i}>
                      <i className="dot" style={{ background: agentColor(a.agent) }} aria-hidden="true" />
                      <b>{agentLabel(a.agent)}</b> {a.outcome} · {ago(a.at)}
                      {a.note && <div className="sub">{a.note}</div>}
                      {a.log && <pre>{a.log}</pre>}
                    </li>
                  ))}
                </ol>
              )}
              <div className="row-actions">
                {j.applyUrl && (
                  <a className="btn alt small" href={j.applyUrl} target="_blank" rel="noreferrer">
                    Open posting ↗
                  </a>
                )}
                <button className="ghost" disabled={busy === j.id} onClick={() => void act(j, () => reportJob(j.id, "applied", "Finished in the assisted queue", undefined))}>
                  Mark applied
                </button>
                <button className="ghost" disabled={busy === j.id} onClick={() => void act(j, () => releaseJob(j.id, "Back to the queue from the assisted list"))}>
                  Back to queue
                </button>
                <button className="ghost danger" disabled={busy === j.id} onClick={() => void act(j, () => reportJob(j.id, "skipped", "Skipped from the assisted queue"))}>
                  Skip
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
