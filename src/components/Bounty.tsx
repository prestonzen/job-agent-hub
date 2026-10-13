import { CYBER_RUBRIC, cyberLeaderboard, scoreCyber } from "../cyber-score";
import { useEffect, useState } from "react";
import { getBounty, type BountyEvent, type BountySummary } from "../api";

/**
 * Bug bounty lane: programs the fleet is enrolled in, recon scans, confirmed findings,
 * submitted reports and payouts. Same "agents find work" engine — pointed at disclosure
 * programs instead of job boards. Data is pushed by runner-side tooling via POST /api/agent/bounty.
 */

const SEV_ORDER = ["critical", "high", "medium", "low", "info"] as const;

const KIND_LABEL: Record<BountyEvent["kind"], string> = {
  program: "Program",
  scan: "Scan",
  finding: "Finding",
  report: "Report",
  payout: "Payout",
};

function ago(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function Kpi({ label, value, money = false }: { label: string; value: number; money?: boolean }) {
  return (
    <div className="kpi">
      <div className="kpi-v">{money ? `$${value.toLocaleString()}` : value.toLocaleString()}</div>
      <div className="kpi-l">{label}</div>
    </div>
  );
}

export default function Bounty() {
  const [data, setData] = useState<BountySummary | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const load = () => getBounty().then(setData).catch((e: Error) => setErr(e.message));
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 60_000);
    return () => clearInterval(t);
  }, []);

  if (err && !data) return <p className="notice">Couldn't load bounty data: {err}</p>;
  if (!data) return <p className="notice">Loading…</p>;

  const activity=data.recent.filter(e=>e.platform!=="benchmark");
  const t = data.totals;
  const maxSev = Math.max(1, ...SEV_ORDER.map((s) => t.bySeverity[s] ?? 0));
  const empty = t.programs + t.scans + t.findings + t.reports + t.payouts === 0;

  return (
    <>
      {err && <p className="notice">Refresh failed: {err}</p>}

      <section className="kpis">
        <Kpi label="Programs" value={t.programs} />
        <Kpi label="Scans run" value={t.scans} />
        <Kpi label="Hosts scanned" value={t.hostsScanned} />
        <Kpi label="Findings" value={t.findings} />
        <Kpi label="Reports submitted" value={t.reports} />
        <Kpi label="Payouts" value={t.payoutsUsd} money />
      </section>

      {empty && (
        <section className="card">
          <div className="card-head">
            <h2>No bounty activity yet</h2>
          </div>
          <p className="muted">
            Events land here as the fleet enrolls in programs and scans in-scope assets. Tooling pushes them with{" "}
            <code>POST /api/agent/bounty</code> — kinds: program, scan, finding, report, payout.
          </p>
        </section>
      )}

      {t.findings > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>Findings by severity</h2>
          </div>
          <div className="bars">
            {SEV_ORDER.map((s) => {
              const n = t.bySeverity[s] ?? 0;
              if (!n) return null;
              return (
                <div key={s} className="bar-row">
                  <span className={`chip sev-${s}`}>{s}</span>
                  <div className="bar-track">
                    <div className={`bar-fill sev-${s}`} style={{ width: `${(n / maxSev) * 100}%` }} />
                  </div>
                  <b>{n}</b>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {data.programs.length > 0 && (
        <section className="card wide">
          <div className="card-head">
            <h2>Programs</h2>
          </div>
          <table>
            <thead>
              <tr>
                <th>Program</th>
                <th>Platform</th>
                <th>Scans</th>
                <th>Findings</th>
                <th>Reports</th>
                <th>Payouts</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {data.programs.map((p) => (
                <tr key={p.program}>
                  <td>{p.program}</td>
                  <td>{p.platform ?? "—"}</td>
                  <td>{p.scans}</td>
                  <td>{p.findings}</td>
                  <td>{p.reports}</td>
                  <td>{p.payoutsUsd ? `$${p.payoutsUsd.toLocaleString()}` : "—"}</td>
                  <td>{ago(p.lastAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {(data.matrix??[]).length>0 && <section className="card wide">
        <h2>Cyber leaderboard</h2>
        <p className="muted small">{CYBER_RUBRIC} · verdict /50, severity /20, validation /20, first pick /10. Latest attempt per scenario; equal scenario weight. Scores compare synthetic judgment, not confirmed vulnerabilities.</p>
        <table><thead><tr><th>Agent</th><th>Score /100</th><th>Verdict</th><th>Severity</th><th>Validation</th><th>Priority</th><th>Coverage</th></tr></thead><tbody>
          {cyberLeaderboard(data.matrix).map(r=><tr key={r.agent}><td><b>{r.agent}</b></td><td>{r.score??'Unscored'}</td><td>{r.verdict??'—'}</td><td>{r.severity??'—'}</td><td>{r.validation??'—'}</td><td>{r.priority??'—'}</td><td>{r.coverage}/3{r.coverage<3?' · provisional':''}{r.unscored?` · ${r.unscored} unscored`:''}</td></tr>)}
        </tbody></table>
        <details><summary>Scoring details and recent attempts</summary><p className="small">HTTP 200 alone does not prove secrets, historical snapshots do not prove current exposure, public assets and missing headers do not justify high severity. Validation and conditional severity receive credit. Repeated runs do not increase scenario weight.</p>
        <table><thead><tr><th>When</th><th>Agent</th><th>Scenario</th><th>Score</th><th>Feedback</th></tr></thead><tbody>{data.matrix.slice(0,25).map(e=>{const r=scoreCyber(e.program,e.detail);return <tr key={e.id}><td>{ago(e.at)}</td><td>{e.agent}</td><td>{r.scenario}</td><td>{r.score??'Unscored'}</td><td>{r.notes.join(' · ')||'Rubric criteria met'}</td></tr>})}</tbody></table></details>
      </section>}

      {activity.length > 0 && (
        <section className="card wide">
          <div className="card-head">
            <h2>Recent activity</h2>
          </div>
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Kind</th>
                <th>What</th>
                <th>Program / target</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {activity.slice(0,12).map((e) => (
                <tr key={e.id}>
                  <td className="nowrap">{ago(e.at)}</td>
                  <td>
                    <span className={`chip kind-${e.kind}`}>{KIND_LABEL[e.kind]}</span>
                    {e.severity && <span className={`chip sev-${e.severity}`}> {e.severity}</span>}
                  </td>
                  <td>
                    {e.title ?? "—"}
                    {e.amount != null && <b> ${e.amount.toLocaleString()}</b>}
                    {e.status && <span className="muted"> · {e.status}</span>}
                  </td>
                  <td>
                    {e.program ?? "—"}
                    {e.target && <div className="sub">{e.target}</div>}
                  </td>
                  <td>{e.agent}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
