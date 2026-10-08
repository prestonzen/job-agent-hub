import { useCallback, useEffect, useMemo, useState } from "react";
import { getHub, releaseJob, reportJob } from "../api";
import type { HubState, Job } from "../types";
import { agentColor } from "../agents";

const ONLINE_MS = 15 * 60_000;
const REFRESH_MS = 20_000;

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function ago(iso: string): string {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function AgentDot({ name }: { name: string }) {
  return <i className="dot" style={{ background: agentColor(name) }} aria-hidden="true" />;
}

const EVENT_LABEL: Record<string, string> = {
  claimed: "claimed",
  released: "released",
  applied: "applied to",
  skipped: "skipped",
  needs_human: "needs you on",
  failed: "failed on",
  added: "queued",
};

export default function CommandCenter() {
  const [hub, setHub] = useState<HubState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "available" | "claimed" | "human">("all");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setHub(await getHub());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const agents = useMemo(() => {
    if (!hub) return [];
    const names = new Set([...hub.agents, ...hub.heartbeats.map((h) => h.agent), ...Object.keys(hub.applied)]);
    names.delete("unknown");
    return [...names]
      .map((name) => {
        const hb = hub.heartbeats.find((h) => h.agent === name);
        return {
          name,
          lastSeen: hb?.lastSeen ?? null,
          client: hb?.client ?? null,
          online: !!hb && Date.now() - Date.parse(hb.lastSeen) < ONLINE_MS,
          holding: hub.queue.filter((j) => j.claimedBy === name).length,
          applied: hub.applied[name] ?? 0,
          hasToken: hub.agents.includes(name),
        };
      })
      .sort((a, b) => Number(b.online) - Number(a.online) || b.applied - a.applied || a.name.localeCompare(b.name));
  }, [hub]);

  if (err) return <p className="notice">Couldn't load the command center: {err}</p>;
  if (!hub) return <p className="notice">Loading…</p>;

  const available = hub.queue.filter((j) => !j.claimedBy && !j.needsHuman && j.applyUrl);
  const claimed = hub.queue.filter((j) => j.claimedBy);
  const human = hub.queue.filter((j) => j.needsHuman);
  const shown =
    filter === "available" ? available : filter === "claimed" ? claimed : filter === "human" ? human : hub.queue;

  async function act(job: Job, fn: () => Promise<unknown>) {
    setBusy(job.id);
    try {
      await fn();
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function skip(job: Job) {
    const note = window.prompt(`Why skip "${job.name}"? (saved as a ClickUp comment)`);
    if (note?.trim()) void act(job, () => reportJob(job.id, "skipped", note.trim()));
  }

  function markApplied(job: Job) {
    if (window.confirm(`Mark "${job.name}" as applied by you (Human)?`)) void act(job, () => reportJob(job.id, "applied"));
  }

  return (
    <>
      {hub.demo && <p className="badge">Demo data</p>}
      <section className="kpis">
        <Kpi label="Ready to claim" value={available.length} onClick={() => setFilter("available")} active={filter === "available"} />
        <Kpi label="In progress" value={claimed.length} onClick={() => setFilter("claimed")} active={filter === "claimed"} />
        <Kpi label="Needs you" value={human.length} onClick={() => setFilter("human")} active={filter === "human"} warn={human.length > 0} />
        <Kpi label="Agents online" value={`${agents.filter((a) => a.online).length}/${agents.length}`} />
      </section>

      <div className="grid two">
        <section className="card">
          <h2>Agents</h2>
          {agents.length === 0 ? (
            <p className="muted">No agents yet. Add tokens, then use “Connect agents”.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Last seen</th>
                  <th className="r">Holding</th>
                  <th className="r">Applied</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.name}>
                    <td className="nowrap">
                      <AgentDot name={a.name} />
                      {cap(a.name)}
                      {a.online && <span className="pill live">online</span>}
                      {!a.hasToken && <span className="sub">no token</span>}
                    </td>
                    <td title={a.client ?? undefined}>{a.lastSeen ? ago(a.lastSeen) : <span className="muted">never</span>}</td>
                    <td className="r">{a.holding}</td>
                    <td className="r">{a.applied}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="card">
          <h2>Live activity</h2>
          {hub.events.length === 0 ? (
            <p className="muted">Nothing yet. Agent claims and results show up here.</p>
          ) : (
            <ol className="feed">
              {hub.events.slice(0, 40).map((e) => (
                <li key={e.id}>
                  <span className="when">{time(e.at)}</span>
                  <span>
                    <AgentDot name={e.agent} />
                    <b>{cap(e.agent)}</b> {EVENT_LABEL[e.type] ?? e.type} {e.taskName ?? ""}
                    {e.message && <span className="sub">{e.message}</span>}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <section className="card wide">
        <div className="card-head">
          <h2>Queue ({shown.length})</h2>
          <div className="seg" role="group" aria-label="Filter queue">
            {(["all", "available", "claimed", "human"] as const).map((f) => (
              <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                {f === "human" ? "needs you" : f}
              </button>
            ))}
          </div>
        </div>
        <p className="muted small">
          Agents claim from the top: best fit first, then ClickUp priority. Claims last {hub.leaseMinutes} min.
        </p>
        <table>
          <thead>
            <tr>
              <th>Job</th>
              <th>ATS</th>
              <th className="r">Fit</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((j) => (
              <tr key={j.id}>
                <td>
                  {j.applyUrl ? (
                    <a href={j.applyUrl} target="_blank" rel="noreferrer">
                      {j.name}
                    </a>
                  ) : (
                    j.name
                  )}
                  <div className="sub">
                    {[j.pay && `Pay ${j.pay}`, j.travel && `Travel ${j.travel}`, j.fitNote].filter(Boolean).join(" · ")}
                  </div>
                </td>
                <td>{j.ats ?? "—"}</td>
                <td className="r">{j.fit ?? "—"}</td>
                <td>
                  {j.needsHuman ? (
                    <span className="pill warn" title={j.needsHuman}>
                      needs you
                    </span>
                  ) : j.claimedBy ? (
                    <span className="nowrap">
                      <AgentDot name={j.claimedBy} />
                      {cap(j.claimedBy)} until {j.claimExpiresAt ? time(j.claimExpiresAt) : "?"}
                    </span>
                  ) : j.applyUrl ? (
                    <span className="pill s-not-started">ready</span>
                  ) : (
                    <span className="muted">no apply link</span>
                  )}
                  {j.needsHuman && <div className="sub">{j.needsHuman}</div>}
                </td>
                <td className="r nowrap">
                  {(j.claimedBy || j.needsHuman) && (
                    <button className="ghost" disabled={busy === j.id} onClick={() => void act(j, () => releaseJob(j.id))}>
                      Release
                    </button>
                  )}{" "}
                  <button className="ghost" disabled={busy === j.id} onClick={() => markApplied(j)}>
                    Applied
                  </button>{" "}
                  <button className="ghost" disabled={busy === j.id} onClick={() => skip(j)}>
                    Skip
                  </button>{" "}
                  <a href={j.clickupUrl} target="_blank" rel="noreferrer" aria-label={`Open ${j.name} in ClickUp`}>
                    ↗
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function Kpi(props: { label: string; value: string | number; onClick?: () => void; active?: boolean; warn?: boolean }) {
  const body = (
    <>
      <div className={`kpi-v${props.warn ? " warn" : ""}`}>{props.value}</div>
      <div className="kpi-l">{props.label}</div>
    </>
  );
  return props.onClick ? (
    <button className={`kpi click${props.active ? " on" : ""}`} onClick={props.onClick}>
      {body}
    </button>
  ) : (
    <div className="kpi">{body}</div>
  );
}
