import type { PublicApplication } from "../types";

export const AGENT_COLORS: Record<string, string> = {
  Claude: "#d97757",
  Codex: "#10a37f",
  Gemini: "#4285f4",
  Kimi: "#7c4dff",
  Mistral: "#fa520f",
  Ollama: "#6b7280",
  Human: "#0f6b5c",
};

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function Funnel({ items }: { items: { label: string; value: number }[] }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <Card title="Funnel">
      {items.map((i) => (
        <div className="row" key={i.label}>
          <span className="lbl">{i.label}</span>
          <span className="bar">
            <span style={{ width: `${(i.value / max) * 100}%` }} />
          </span>
          <span className="num">{i.value}</span>
        </div>
      ))}
    </Card>
  );
}

export function AgentSplit({ byAgent }: { byAgent: Record<string, number> }) {
  const entries = Object.entries(byAgent).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, n]) => s + n, 0) || 1;
  return (
    <Card title="Who applied">
      <div className="stack" role="img" aria-label="Share of applications by agent">
        {entries.map(([name, n]) => (
          <span key={name} style={{ width: `${(n / total) * 100}%`, background: AGENT_COLORS[name] ?? "#94a3b8" }} />
        ))}
      </div>
      <ul className="legend">
        {entries.map(([name, n]) => (
          <li key={name}>
            <i style={{ background: AGENT_COLORS[name] ?? "#94a3b8" }} />
            {name} <b>{n}</b>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function DailyBars({ days }: { days: { date: string; count: number }[] }) {
  const max = Math.max(1, ...days.map((d) => d.count));
  return (
    <Card title="Applications per day">
      {days.length === 0 ? (
        <p className="muted">No dated applications yet.</p>
      ) : (
        <div className="spark">
          {days.map((d) => (
            <div key={d.date} className="col" title={`${d.date}: ${d.count}`}>
              <span style={{ height: `${(d.count / max) * 100}%` }} />
              <small>{d.date.slice(5)}</small>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export function PlatformTable({
  byPlatform,
  platforms,
}: {
  byPlatform: Record<string, number>;
  platforms: { name: string; status: string }[];
}) {
  const rows = Object.entries(byPlatform).sort((a, b) => b[1] - a[1]);
  return (
    <Card title="Platforms">
      <table>
        <thead>
          <tr>
            <th>Channel</th>
            <th className="r">Applications</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, n]) => (
            <tr key={name}>
              <td>{name}</td>
              <td className="r">{n}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {platforms.length > 0 && (
        <>
          <h3>Networks &amp; marketplaces</h3>
          <ul className="chips">
            {platforms.map((p) => (
              <li key={p.name} className={`chip s-${p.status.replace(/\W+/g, "-")}`}>
                {p.name} · {p.status}
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

export function ActivityFeed({ items }: { items: PublicApplication[] }) {
  return (
    <section className="card wide">
      <h2>Recent activity</h2>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Company</th>
            <th>Role</th>
            <th>Platform</th>
            <th>By</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((a, i) => (
            <tr key={i}>
              <td>{a.appliedOn ?? "—"}</td>
              <td>{a.company}</td>
              <td>{a.role}</td>
              <td>{a.platform ?? "—"}</td>
              <td>{a.appliedBy ?? "—"}</td>
              <td>
                <span className={`pill s-${a.status.replace(/\W+/g, "-")}`}>{a.status}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
