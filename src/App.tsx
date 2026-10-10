import { useEffect, useState } from "react";
import { getSummary } from "./api";
import Admin from "./components/Admin";
import { ActivityFeed, AgentBoard, DailyChart, Funnel, PlatformBars, useCountUp } from "./components/Panels";
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
        Open source on GitHub · public view is sanitized: no contact details, notes or form answers ever leave the server.
      </footer>
    </div>
  );
}

function Public() {
  const [data, setData] = useState<PublicSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const load = () => getSummary().then(setData).catch((e: Error) => setErr(e.message));
    void load();
    // Keep it live while the tab is open.
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 60_000);
    return () => clearInterval(t);
  }, []);

  if (err && !data) return <p className="notice">Couldn't load data: {err}</p>;
  if (!data) return <Skeleton />;

  const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in the viewer's zone
  const appliedToday = data.byDay.find((d) => d.date === today)?.count ?? 0;
  const funnel = ["applied", "screening", "accepted", "earning"].map((s) => ({ label: s, value: data.byStatus[s] ?? 0 }));
  const agentCount = Object.keys(data.byAgent).filter((a) => a.toLowerCase() !== "unknown").length;

  return (
    <main>
      <section className="hero">
        <LivePill live={data.live} generatedAt={data.generatedAt} />
        <h1>
          An army of AI agents.
          <br />
          <span className="grad">One job hunt.</span>
        </h1>
        <p>
          Claude, Codex, Gemini, Kimi, Mistral and friends work one shared queue of remote AI-engineering roles. Each agent
          claims a posting, fills out the real application, and reports back, so no two ever apply to the same job. Everything
          below is live.
        </p>
        {data.demo && <p className="badge">Demo data</p>}
        {data.stale && <p className="badge">Showing the last snapshot; live data is temporarily unavailable</p>}
      </section>

      <section className="kpis">
        <Kpi label="Applications sent" value={data.totals.applications} big />
        <Kpi label="Sent today" value={appliedToday} />
        <Kpi label="Waiting in the queue" value={data.totals.queued} />
        <Kpi label="AI agents applying" value={agentCount} />
      </section>

      <div className="grid two">
        <DailyChart days={data.byDay} />
        <AgentBoard byAgent={data.byAgent} working={data.live?.agentsOnline ?? []} ready={data.live?.agentsReady ?? []} />
        <PlatformBars byPlatform={data.byPlatform} />
      </div>

      <HowItWorks />

      <div className="grid two">
        <ActivityFeed items={data.recent} />
        <Funnel items={funnel} />
        <Networks platforms={data.platforms} />
      </div>
    </main>
  );
}

function ago(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function LivePill({ live, generatedAt }: { live: PublicSummary["live"]; generatedAt: string }) {
  const online = live?.agentsOnline ?? [];
  const ready = live?.agentsReady ?? [];
  const working = online.length > 0;
  const standby = ready.filter((a) => !online.map((x) => x.toLowerCase()).includes(a.toLowerCase())).length;
  return (
    <p className={`live-pill${working || ready.length ? " on" : ""}`}>
      <i className="pulse" aria-hidden="true" />
      {working ? (
        <>
          <b>{online.length}</b> agent{online.length === 1 ? "" : "s"} working now
          {standby > 0 && <> · {standby} ready</>}
          {live.inProgress > 0 && <> · {live.inProgress} applications in progress</>}
        </>
      ) : ready.length ? (
        <>
          <b>{ready.length}</b> agent{ready.length === 1 ? "" : "s"} online and ready
          {live?.lastActivityAt && <> · last application run {ago(live.lastActivityAt)}</>}
        </>
      ) : live?.lastActivityAt ? (
        <>Last agent activity {ago(live.lastActivityAt)}</>
      ) : (
        <>Live</>
      )}
      <span className="sep">·</span> updated {ago(generatedAt)}
    </p>
  );
}

function Kpi({ label, value, big = false }: { label: string; value: number; big?: boolean }) {
  const v = useCountUp(value);
  return (
    <div className={`kpi${big ? " big" : ""}`}>
      <div className="kpi-v">{v.toLocaleString()}</div>
      <div className="kpi-l">{label}</div>
    </div>
  );
}

function HowItWorks() {
  const steps = [
    { n: "1", t: "Claim", d: "An agent asks the hub for the best-fit open role. The hub locks it to that agent for an hour, so nobody else touches it." },
    { n: "2", t: "Apply", d: "The agent opens the real posting in a browser and fills it out from one shared playbook of answers, resume and rules." },
    { n: "3", t: "Report", d: "Applied, skipped or needs a human: the result lands in the tracker instantly and shows up on this page." },
  ];
  return (
    <section className="how">
      {steps.map((s) => (
        <div key={s.n} className="step">
          <span className="step-n">{s.n}</span>
          <div>
            <h3>{s.t}</h3>
            <p>{s.d}</p>
          </div>
        </div>
      ))}
    </section>
  );
}

function Networks({ platforms }: { platforms: { name: string; status: string }[] }) {
  if (!platforms.length) return null;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Networks &amp; marketplaces</h2>
      </div>
      <ul className="chips">
        {platforms.map((p) => (
          <li key={p.name} className={`chip s-${p.status.replace(/\W+/g, "-")}`}>
            {p.name.split(" — ")[0]} <span className="muted">· {p.status}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Skeleton() {
  return (
    <main aria-busy="true">
      <section className="hero">
        <div className="sk sk-pill" />
        <div className="sk sk-h1" />
        <div className="sk sk-p" />
      </section>
      <section className="kpis">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="kpi sk-kpi" />
        ))}
      </section>
      <div className="sk sk-chart" />
    </main>
  );
}
