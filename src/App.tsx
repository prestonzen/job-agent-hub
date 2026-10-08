import { useEffect, useState } from "react";
import { getSummary } from "./api";
import Admin from "./components/Admin";
import { ActivityFeed, AgentSplit, DailyBars, Funnel, PlatformTable } from "./components/Panels";
import type { PublicSummary } from "./types";

const REPO = "https://github.com/prestonzen/job-agent-hub";

export default function App() {
  const isAdmin = window.location.pathname.startsWith("/admin");
  return (
    <div className="shell">
      <header className="top">
        <a className="brand" href="/">
          <span className="logo" aria-hidden="true" />
          Job Agent Hub
        </a>
        <nav>
          <a href="/">Public</a>
          <a href="/admin">Admin</a>
          <a href={REPO} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </nav>
      </header>
      {isAdmin ? <Admin /> : <Public />}
      <footer className="foot">
        Open-source showcase · public view is sanitized: no contact details, notes or form answers ever leave the server.
      </footer>
    </div>
  );
}

function Public() {
  const [data, setData] = useState<PublicSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    getSummary().then(setData).catch((e: Error) => setErr(e.message));
  }, []);

  if (err) return <p className="notice">Couldn't load data: {err}</p>;
  if (!data) return <p className="notice">Loading…</p>;

  const funnel = ["applied", "screening", "accepted", "earning"].map((s) => ({ label: s, value: data.byStatus[s] ?? 0 }));

  return (
    <main>
      <section className="hero">
        <h1>One pane of glass for an AI-assisted job search</h1>
        <p>
          Humans and AI agents (Claude, Codex, Gemini, Kimi, Mistral, Ollama) work one shared job queue: each agent claims a
          posting, applies, and reports back, so no two agents ever apply to the same role. Every action lands in one tracker,
          shown here live.
        </p>
        {data.demo && <p className="badge">Demo data</p>}
        {data.stale && <p className="badge">Showing the last snapshot; live data is temporarily unavailable</p>}
      </section>

      <section className="kpis">
        <Kpi label="Applications" value={data.totals.applications} />
        <Kpi label="In the queue" value={data.totals.queued} />
        <Kpi label="In screening+" value={(data.byStatus["screening"] ?? 0) + (data.byStatus["accepted"] ?? 0) + (data.byStatus["earning"] ?? 0)} />
        <Kpi label="Updated" value={new Date(data.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} />
      </section>

      <div className="grid">
        <Funnel items={funnel} />
        <AgentSplit byAgent={data.byAgent} />
        <DailyBars days={data.byDay} />
        <PlatformTable byPlatform={data.byPlatform} platforms={data.platforms} />
      </div>
      <ActivityFeed items={data.recent} />
    </main>
  );
}

function Kpi({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="kpi">
      <div className="kpi-v">{value}</div>
      <div className="kpi-l">{label}</div>
    </div>
  );
}
