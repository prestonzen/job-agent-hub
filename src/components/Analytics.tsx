import { useCallback, useEffect, useState } from "react";
import { getAnalytics, type Analytics as AnalyticsData } from "../api";
import { agentColor, agentLabel } from "../agents";
import { Spark, StackedColumns } from "./Charts";
import { Card, useCountUp } from "./Panels";

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
  const num = typeof value === "number" ? value : null;
  const v = useCountUp(num ?? 0);
  return (
    <div className="kpi">
      <div className={`kpi-v${tone === "warn" ? " warn" : ""}`}>{num !== null ? v.toLocaleString() : value}</div>
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
        <Stat label="Applications sent" value={t.applied} sub={`${t.claimed} jobs claimed`} />
        <Stat label="Success rate" value={pct(t.successRate)} sub="applied ÷ finished attempts" />
        <Stat label="Median time to apply" value={mins(t.medianMinToApply)} sub="claim → submitted" />
        <Stat label="Agent run time" value={`${(t.runMinutes / 60).toFixed(1)} h`} sub={`${t.runsOk}/${t.runs} runs succeeded`} />
        <Stat label="Applications per run-hour" value={t.appsPerRunHour === null ? "—" : t.appsPerRunHour.toFixed(1)} sub="throughput" />
        <Stat label="Ready in the queue" value={data.queue.ready} sub={`${data.queue.claimed} in progress`} />
        <Stat label="Parked for a person" value={data.queue.parked} tone={data.queue.parked ? "warn" : undefined} sub="not claimable" />
        <Stat label="Agents ready now" value={data.fleet.agentsReady} sub={`${data.fleet.runnersOnline} runner${data.fleet.runnersOnline === 1 ? "" : "s"} online`} />
      </section>

      <Card title="Outcomes per day" className="wide chart-card" aside={<Legend items={OUTCOMES} />}>
        <StackedColumns rows={rows} series={OUTCOMES} ariaLabel={`Outcomes per day over the last ${days} days`} />
      </Card>

      <Card title="Agent scorecard" className="wide">
        <div className="table-scroll">
          <table className="score">
            <thead>
              <tr>
                <th>Agent</th>
                <th className="r">Applied</th>
                <th className="r">Claimed</th>
                <th className="r" title="Marked needs-a-person">Parked</th>
                <th className="r">Skipped</th>
                <th className="r">Failed</th>
                <th>Success</th>
                <th className="r">Median apply</th>
                <th>Runs</th>
                <th className="r">Avg run</th>
                <th className="r">Run time</th>
              </tr>
            </thead>
            <tbody>
              {data.byAgent.map((a) => {
                const done = a.runsOk + a.runsFailed;
                return (
                  <tr key={a.agent}>
                    <td className="who">
                      <i className="dot" style={{ background: agentColor(a.agent) }} aria-hidden="true" />
                      {agentLabel(a.agent)}
                    </td>
                    <td className="r">
                      <b>{a.applied}</b>
                    </td>
                    <td className="r">{a.claimed}</td>
                    <td className="r">{a.needsHuman}</td>
                    <td className="r">{a.skipped}</td>
                    <td className="r">{a.failed}</td>
                    <td>
                      <span className="mini">
                        <span className="mini-track">
                          <span style={{ width: `${(a.successRate ?? 0) * 100}%`, background: agentColor(a.agent) }} />
                        </span>
                        <span className="mini-n">{pct(a.successRate)}</span>
                      </span>
                    </td>
                    <td className="r">{mins(a.medianMinToApply)}</td>
                    <td>
                      {done ? (
                        <span className="mini" title={`${a.runsOk} succeeded, ${a.runsFailed} failed`}>
                          <span className="mini-track">
                            <span style={{ width: `${(a.runsOk / done) * 100}%`, background: "var(--accent)" }} />
                          </span>
                          <span className="mini-n">
                            {a.runsOk}/{done}
                          </span>
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="r">{mins(a.avgRunMin)}</td>
                    <td className="r">{a.runMinutes ? `${(a.runMinutes / 60).toFixed(1)} h` : "—"}</td>
                  </tr>
                );
              })}
              {!data.byAgent.length && (
                <tr>
                  <td colSpan={11} className="muted">
                    No agent activity in this window yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
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
                  <span className="pct">{pct(a.successRate)}</span>
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
          <h3>ClickUp API calls per day</h3>
          <Spark values={data.clickup.map((c) => c.calls)} />
          <p className="muted small">
            {data.clickup.length ? `${data.clickup[data.clickup.length - 1].calls.toLocaleString()} calls today` : "No calls recorded"} · every agent reads the hub's cached copy,
            so the count stays flat as more agents join.
          </p>
        </Card>
      </div>
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
