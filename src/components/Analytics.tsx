import { useCallback, useEffect, useState } from "react";
import { getAnalytics, type Analytics as AnalyticsData } from "../api";
import { agentColor, agentLabel, identityLabel } from "../agents";
import { Spark, StackedColumns } from "./Charts";
import { Card } from "./Panels";

const OUTCOMES = [
  { key: "applied", label: "Applied", color: "var(--accent)" },
  { key: "needsHuman", label: "Needs a person", color: "var(--warn)" },
  { key: "skipped", label: "Skipped", color: "var(--agent-unknown)" },
  { key: "failed", label: "Failed", color: "#e5484d" },
];

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
const mins = (v: number | null) => (v === null ? "—" : v < 90 ? `${Math.round(v)} min` : `${(v / 60).toFixed(1)} h`);
const fmtDay = (iso: string, o: Intl.DateTimeFormatOptions) => new Date(`${iso}T12:00:00Z`).toLocaleDateString([], { timeZone: "UTC", ...o });

function Stat({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: "warn" | "ok" }) {
  return (
    <div className="kpi">
      <div className={`kpi-v${tone === "warn" ? " warn" : ""}`}>{typeof value === "number" ? value.toLocaleString() : value}</div>
      <div className="kpi-l">{label}</div>
      {sub && <div className="kpi-s">{sub}</div>}
    </div>
  );
}

export default function Analytics() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getAnalytics(days));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [days]);

  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  if (err && !data) return <p className="notice">Couldn't load analytics: {err}</p>;
  if (!data) return <p className="notice">Loading analytics…</p>;

  const t = data.totals;
  const rows = data.byDay.map((d) => ({
    label: fmtDay(d.date, { month: "short", day: "numeric" }),
    sub: fmtDay(d.date, { weekday: "long", month: "long", day: "numeric" }),
    values: { applied: d.applied, needsHuman: d.needsHuman, skipped: d.skipped, failed: d.failed },
  }));

  // Hours are stored in UTC; show them in the viewer's time zone.
  const offsetH = -new Date().getTimezoneOffset() / 60;
  const local = Array.from({ length: 24 }, (_, h) => data.byHour[(((h - offsetH) % 24) + 24) % 24]);
  const hourMax = Math.max(1, ...local);

  const atsMax = Math.max(1, ...data.byAts.map((a) => a.applied + a.needsHuman + a.skipped + a.failed));
  const parkedMax = Math.max(1, ...data.parked.map((p) => p.count));

  return (
    <>
      <div className="an-bar">
        <div className="seg" role="group" aria-label="Time range">
          {[7, 30, 90].map((d) => (
            <button key={d} className={days === d ? "on" : ""} onClick={() => setDays(d)}>
              {d} days
            </button>
          ))}
        </div>
        <span className="muted small">
          {data.demo ? "Demo data · " : ""}Computed from hub events and runs · updated {new Date(data.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>

      <section className="kpis an-kpis">
        <Stat label="Submitted" value={t.applied} sub={`agents reported applied · ${t.claimed} claimed`} />
        <Stat label="Confirmed received" value={t.confirmed} tone={t.applied > 0 && t.confirmed === 0 ? "warn" : "ok"} sub={`${pct(t.landingRate)} of submissions produced a receipt`} />
        <Stat label="Replies" value={t.replied ?? 0} sub={`${t.positive ?? 0} positive (interview / assessment / offer)`} tone={(t.positive ?? 0) > 0 ? "ok" : undefined} />
        <Stat label="Form completion" value={pct(t.successRate)} sub="reported applied ÷ finished attempts (not a landing rate)" />
        <Stat label="Median time to apply" value={mins(t.medianMinToApply)} sub="claim → submitted" />
        <Stat label="Agent run time" value={`${(t.runMinutes / 60).toFixed(1)} h`} sub={`${t.runsOk}/${t.runs} processes completed; diagnostics excluded`} />
        <Stat label="Applications per run-hour" value={t.appsPerRunHour === null ? "—" : t.appsPerRunHour.toFixed(1)} sub="throughput" />
        <Stat label="Open postings" value={data.queue.ready} sub={`${data.queue.claimed} in progress`} />
        <Stat label="Parked for a person" value={data.queue.parked} tone={data.queue.parked ? "warn" : undefined} sub="not claimable" />
        <Stat label="Agents ready now" value={data.fleet.agentsReady} sub={`${data.fleet.runnersOnline} runner${data.fleet.runnersOnline === 1 ? "" : "s"} online`} />
        {data.bounty && (data.bounty.programs > 0 || data.bounty.findings > 0) && (
          <>
            <Stat label="Bounty programs" value={data.bounty.programs} sub={`${data.bounty.scans} scans · ${data.bounty.hostsScanned} hosts`} />
            <Stat label="Bounty finding leads" value={data.bounty.findings} sub={`${data.bounty.reports} report records`} />
            <Stat label="Bounty payouts" value={`$${data.bounty.payoutsUsd.toLocaleString()}`} sub={`${data.bounty.payouts} payout${data.bounty.payouts === 1 ? "" : "s"}`} />
          </>
        )}
      </section>

      <Card title="Landing funnel by channel" className="wide" aside={<span className="muted small">submitted → confirmed → replied → positive</span>}>
        <p className="muted small">
          “Applied” only means an agent saw a thank-you page. A <b>receipt</b> proves the company's inbox took it; a <b>reply</b> proves a person or their ATS acted on it.
          Median reply {data.insights.medianDaysToReply === null ? "—" : `${data.insights.medianDaysToReply} d`} · median rejection {data.insights.medianDaysToRejection === null ? "—" : `${data.insights.medianDaysToRejection} d`}.
        </p>
        <table className="score"><thead><tr><th>Channel</th><th>Submitted</th><th>Confirmed</th><th>Landing rate</th><th>Replied</th><th>Positive</th><th>Rejected</th><th>Median reply</th></tr></thead><tbody>
          {data.insights.funnel.map((f) => (
            <tr key={f.channel}>
              <td className="who">{f.channel}</td><td>{f.submitted}</td><td>{f.confirmed}</td>
              <td className={f.submitted >= 5 && (f.landingRate ?? 0) < 0.2 ? "warn" : ""}>{pct(f.landingRate)}</td>
              <td>{f.replied}</td><td>{f.positive}</td><td>{f.rejected}</td><td>{f.medianDaysToReply === null ? "—" : `${f.medianDaysToReply} d`}</td>
            </tr>
          ))}
          {!data.insights.funnel.length && <tr><td colSpan={8}>No submissions in this window.</td></tr>}
        </tbody></table>
      </Card>

      <div className="grid two">
        <Card title="Submission hour vs outcome" aside={<span className="muted small">Pacific time · ATS forms only</span>}>
          <table className="score"><thead><tr><th>Window</th><th>Submitted</th><th>Confirmed</th><th>Parked</th><th>Failed</th><th>Submitted rate</th></tr></thead><tbody>
            {data.insights.byPtHour.map((b) => { const tot = b.submitted + b.parked + b.failed; return (
              <tr key={b.bucket}><td className="who">{b.bucket}</td><td>{b.submitted}</td><td>{b.confirmed}</td><td>{b.parked}</td><td>{b.failed}</td><td>{tot ? `${Math.round((b.submitted / tot) * 100)}%` : "—"}</td></tr>
            ); })}
          </tbody></table>
        </Card>
        <Card title="Resume variant → replies">
          <table className="score"><thead><tr><th>Variant</th><th>Submitted</th><th>Replied</th><th>Positive</th></tr></thead><tbody>
            {data.insights.resumes.map((r) => <tr key={r.variant}><td className="who">{r.variant}</td><td>{r.submitted}</td><td>{r.replied}</td><td>{r.positive}</td></tr>)}
            {!data.insights.resumes.length && <tr><td colSpan={4}>No applied notes named a resume file.</td></tr>}
          </tbody></table>
        </Card>
      </div>

      <Card title="How to read these numbers">
        <ul className="small">{data.insights.caveats.map((c, i) => <li key={i}>{c}</li>)}</ul>
      </Card>

      <Card title="Outcomes per day" className="wide chart-card" aside={<Legend items={OUTCOMES} />}>
        <StackedColumns rows={rows} series={OUTCOMES} ariaLabel={`Outcomes per day over the last ${days} days`} />
      </Card>

      <Card title="Agent scorecard" className="wide">
        <p className="muted small">Monthly $/app allocates the fixed subscription by tracked monthly token usage, then divides by reported applications. Cyber and sourcing share the bill by their own usage. Missing or outside-hub usage makes these figures provisional.</p>
        <table className="score"><thead><tr><th>Agent</th><th>Reported apps</th><th>Success</th><th>Plan / charges</th><th>Month $/app</th><th>Details</th></tr></thead><tbody>
          {data.byAgent.map(a=><tr key={a.agent}>
            <td className="who"><i className="dot" style={{background:agentColor(a.agent)}} aria-hidden="true"/>{agentLabel(a.agent)}</td>
            <td>{a.applied}</td><td>{pct(a.successRate)}</td>
            <td>{a.monthlyPlanUsd!=null?`$${a.monthlyPlanUsd}/mo`:(a.costUsd??0)?`$${a.costUsd.toFixed(2)} reported`:'—'}</td>
            <td title={`${a.billingMonth}: ${a.costBasis}`}>
              {a.monthlyCostPerApplicationUsd!=null?`~$${a.monthlyCostPerApplicationUsd.toFixed(2)}`:(a.monthlyApplications??0)===0?'No submissions':'Usage missing'}
              {a.monthlyPlanUsd!=null&&<div className="sub">{a.billingMonth} · {a.monthlyApplications} submissions<br/>Usage: {a.monthlyTokenCoverage}</div>}
            </td>
            <td><details><summary>{agentLabel(a.agent)} run details</summary><div className="small">Claimed {a.claimed} · review {a.needsHuman} · skipped {a.skipped} · failed {a.failed}<br/>Median apply: {mins(a.medianMinToApply)}<br/>Processes: {a.runsOk}/{a.runs} completed · average {mins(a.avgRunMin)} · {(a.runMinutes/60).toFixed(1)} h<br/>{(a.monthlyTokens??0).toLocaleString()} tracked monthly tokens</div></details></td>
          </tr>)}
          {!data.byAgent.length&&<tr><td colSpan={6}>No recorded agent work in this window.</td></tr>}
        </tbody></table>
        {(data.byIdentity?.length??0)>0&&<>
          <p className="muted small" style={{marginTop:14}}>Applications credited to each agent variant — distinct configs sharing a base model are counted separately (legacy rows fall back to the model name).</p>
          <table className="score"><thead><tr><th>Identity</th><th>Applied</th></tr></thead><tbody>
            {data.byIdentity!.map(r=><tr key={r.identity}><td className="who">{r.identity.includes("/")?identityLabel(r.identity):agentLabel(r.identity)}</td><td>{r.applied}</td></tr>)}
          </tbody></table>
        </>}
      </Card>

      <div className="grid two">
        <Card title="Yield by application system">
          <p className="muted small">Where applications go through and where they hit a wall. Systems with a low rate are the ones that need a person.</p>
          <ul className="ats-list">
            {data.byAts.map((a) => {
              const total = a.applied + a.needsHuman + a.skipped + a.failed;
              const w = (total / atsMax) * 100;
              return (
                <li key={a.ats} title={`${a.ats}: ${a.applied} applied, ${a.needsHuman} parked, ${a.skipped} skipped, ${a.failed} failed`}>
                  <span className="lbl">{a.ats}</span>
                  <span className="stack" style={{ width: `${w}%` }}>
                    {OUTCOMES.map((o) => {
                      const v = a[o.key as keyof typeof a] as number;
                      return v ? <span key={o.key} style={{ flex: v, background: o.color }} /> : null;
                    })}
                  </span>
                  <span className="num">{total}</span>
                  <span className="pct" title={`${a.confirmed} confirmation receipt${a.confirmed === 1 ? "" : "s"} — submissions that actually landed`}>{pct(a.successRate)} · ✉{a.confirmed}</span>
                </li>
              );
            })}
            {!data.byAts.length && <li className="muted">No results recorded yet.</li>}
          </ul>
        </Card>

        <Card title="Why jobs get parked">
          <p className="muted small">Right now {data.queue.parked} of {data.queue.total} jobs in the queue need a person or a different approach.</p>
          <ul className="hbars">
            {data.parked.map((p) => (
              <li key={p.reason} title={`${p.reason}: ${p.count}`}>
                <span className="lbl">{p.reason}</span>
                <span className="track">
                  <span style={{ width: `${(p.count / parkedMax) * 100}%`, background: "var(--warn)" }} />
                </span>
                <span className="num">{p.count}</span>
              </li>
            ))}
            {!data.parked.length && <li className="muted">Nothing is parked.</li>}
          </ul>
        </Card>

        <Card title="When the agents apply" aside={<span className="muted small">your local time</span>}>
          <div className="hours" role="img" aria-label="Applications by hour of day">
            {local.map((n, h) => (
              <div key={h} className="hour" title={`${String(h).padStart(2, "0")}:00 · ${n} applications`}>
                <span className="hour-bar" style={{ height: `${Math.max(n ? 6 : 2, (n / hourMax) * 100)}%`, opacity: n ? 0.35 + 0.65 * (n / hourMax) : 0.25 }} />
                <span className="hour-l">{h % 3 === 0 ? h : ""}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Hub health">
          <dl className="facts">
            <div>
              <dt>Agents ready</dt>
              <dd>{data.fleet.agentsReady}</dd>
            </div>
            <div>
              <dt>Runners online</dt>
              <dd>
                {data.fleet.runnersOnline} <small>({data.fleet.busy}/{data.fleet.slots} slots busy)</small>
              </dd>
            </div>
            <div>
              <dt>Release / retry rate</dt>
              <dd>{t.claimed ? `${Math.round((data.byAgent.reduce((s, a) => s + a.released, 0) / t.claimed) * 100)}%` : "—"}</dd>
            </div>
          </dl>
          <h3>ClickUp API calls per day (mirror)</h3>
          <Spark values={data.clickup.map((c) => c.calls)} />
          <p className="muted small">
            {data.clickup.length ? `${data.clickup[data.clickup.length - 1].calls.toLocaleString()} calls today` : "No calls recorded"} · every agent reads the hub's cached copy,
            so the count stays flat as more agents join.
          </p>
        </Card>
      </div>

      {data.platforms && data.platforms.length > 0 && (
        <Card title="Platforms we track">
          <p className="muted small">
            Every application system, discovery source and signed-in account the fleet uses — and the ones it deliberately avoids.
            Signed-in sessions were synced into every agent profile on 2026-10-22 via the noVNC manual login.
          </p>
          <div className="grid two">
            {(
              [
                ["ats", "Application systems"],
                ["source", "Discovery sources"],
                ["account", "Signed-in accounts"],
                ["excluded", "Deliberately avoided"],
              ] as const
            ).map(([kind, heading]) => (
              <div key={kind}>
                <h3>{heading}</h3>
                <ul className="platform-list">
                  {data.platforms!
                    .filter((p) => p.kind === kind)
                    .map((p) => {
                      const stats = data.byAts.find((a) => a.ats.toLowerCase() === p.name.toLowerCase());
                      return (
                        <li key={p.name} title={p.note}>
                          <span className={`pill ${p.status}`}>{p.status}</span>
                          <span className="pname">{p.name}</span>
                          {stats && (
                            <span className="muted small">
                              {stats.applied} applied · ✉{stats.confirmed}
                            </span>
                          )}
                          <span className="muted small pnote">{p.note}</span>
                        </li>
                      );
                    })}
                </ul>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}

function Legend({ items }: { items: { key: string; label: string; color: string }[] }) {
  return (
    <ul className="legend" aria-label="Outcomes">
      {items.map((i) => (
        <li key={i.key}>
          <i className="key" style={{ background: i.color }} aria-hidden="true" />
          {i.label}
        </li>
      ))}
    </ul>
  );
}
