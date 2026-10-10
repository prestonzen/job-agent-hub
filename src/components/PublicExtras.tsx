import { agentColor, agentKey, agentLabel, sortAgents } from "../agents";
import type { PublicSummary } from "../types";
import { Card } from "./Panels";

// ---------- Hero: the agent constellation ----------

/** Agents orbiting the hub. Working agents get a packet travelling to the hub; idle-but-ready ones breathe. */
export function Constellation({ byAgent, working, ready }: { byAgent: Record<string, number>; working: string[]; ready: string[] }) {
  // Everyone who has applied, plus agents that are logged in and standing by (they haven't sent anything yet).
  const seen = new Map<string, string>();
  for (const a of [...Object.keys(byAgent), ...working, ...ready]) if (!["unknown", "human"].includes(agentKey(a))) seen.set(agentKey(a), a);
  const names = sortAgents([...seen.values()]);
  const sent = (a: string) => byAgent[a] ?? byAgent[agentLabel(a)] ?? Object.entries(byAgent).find(([k]) => agentKey(k) === agentKey(a))?.[1] ?? 0;
  const isWorking = (a: string) => working.map(agentKey).includes(agentKey(a));
  const isReady = (a: string) => ready.map(agentKey).includes(agentKey(a));
  const W = 440;
  const H = 330;
  const cx = W / 2;
  const cy = H / 2;
  const rx = 168;
  const ry = 112;
  const n = Math.max(1, names.length);
  return (
    <svg className="constellation" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${names.length} AI agents connected to one hub`}>
      <defs>
        <radialGradient id="hubglow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx={cx} cy={cy} rx={rx} ry={ry} className="orbit" />
      <ellipse cx={cx} cy={cy} rx={rx * 0.55} ry={ry * 0.55} className="orbit faint" />
      <circle cx={cx} cy={cy} r={86} fill="url(#hubglow)" />
      {names.map((name, i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
        const x = cx + rx * Math.cos(a);
        const y = cy + ry * Math.sin(a);
        const live = isWorking(name);
        const path = `M${x.toFixed(1)},${y.toFixed(1)} L${cx},${cy}`;
        const above = y < cy - 30; // labels go above only for nodes near the top
        const lblY = above ? y - 48 : y + 42;
        return (
          <g key={name} className={`node${live ? " live" : isReady(name) ? " idle" : ""}`}>
            <path d={path} className={`spoke${live ? " flow" : ""}`} />
            {live && (
              <circle r={4} style={{ fill: agentColor(name) }}>
                <animateMotion dur={`${2.2 + (i % 3) * 0.5}s`} repeatCount="indefinite" path={path} />
              </circle>
            )}
            {(live || isReady(name)) && <circle cx={x} cy={y} r={27} className="ring" style={{ stroke: agentColor(name) }} />}
            <circle cx={x} cy={y} r={22} style={{ fill: agentColor(name) }} />
            <text x={x} y={y + 5} textAnchor="middle" className="node-i">
              {agentLabel(name).slice(0, 2)}
            </text>
            <text x={x} y={lblY} textAnchor="middle" className="node-l">
              {agentLabel(name)}
            </text>
            <text x={x} y={lblY + 14} textAnchor="middle" className="node-n">
              {sent(name) ? `${sent(name)} sent` : "standing by"}
            </text>
          </g>
        );
      })}
      <g>
        <rect x={cx - 34} y={cy - 34} width={68} height={68} rx={18} className="hub-box" />
        <text x={cx} y={cy - 2} textAnchor="middle" className="hub-t">
          HUB
        </text>
        <text x={cx} y={cy + 15} textAnchor="middle" className="hub-s">
          shared queue
        </text>
      </g>
    </svg>
  );
}

// ---------- Calendar heatmap ----------

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function CalendarHeat({ days }: { days: PublicSummary["byDay"] }) {
  const WEEKS = 14;
  const span = days.length ? (Date.now() - Date.parse(`${days[0].date}T12:00:00`)) / 86_400_000 : 0;
  if (span < 12) return null; // a calendar of four filled cells says less than the daily chart above it
  const counts = new Map(days.map((d) => [d.date, d.count]));
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - today.getDay() - (WEEKS - 1) * 7);
  const cols: { date: string; n: number; future: boolean }[][] = [];
  for (let w = 0; w < WEEKS; w++) {
    const col = [];
    for (let d = 0; d < 7; d++) {
      const dt = new Date(start);
      dt.setDate(start.getDate() + w * 7 + d);
      col.push({ date: iso(dt), n: counts.get(iso(dt)) ?? 0, future: dt > today });
    }
    cols.push(col);
  }
  const max = Math.max(1, ...cols.flat().map((c) => c.n));
  const level = (n: number) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4)));
  const total = cols.flat().reduce((s, c) => s + c.n, 0);
  const active = cols.flat().filter((c) => c.n > 0).length;
  const months = cols.map((col, i) => {
    const m = new Date(`${col[0].date}T12:00:00`).toLocaleDateString([], { month: "short" });
    const prev = i ? new Date(`${cols[i - 1][0].date}T12:00:00`).toLocaleDateString([], { month: "short" }) : "";
    return m !== prev ? m : "";
  });
  return (
    <Card title="Activity" aside={<span className="muted small">{total} applications on {active} active days</span>} className="cal-card">
      <div className="cal" role="img" aria-label={`Applications per day, last ${WEEKS} weeks`}>
        <div className="cal-months">
          {months.map((m, i) => (
            <span key={i}>{m}</span>
          ))}
        </div>
        <div className="cal-grid">
          {cols.map((col, i) => (
            <div key={i} className="cal-col">
              {col.map((c) => (
                <i
                  key={c.date}
                  className={`cell l${c.future ? "x" : level(c.n)}`}
                  title={c.future ? "" : `${new Date(`${c.date}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}: ${c.n} application${c.n === 1 ? "" : "s"}`}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="cal-legend">
          less
          {[0, 1, 2, 3, 4].map((l) => (
            <i key={l} className={`cell l${l}`} />
          ))}
          more
        </div>
      </div>
    </Card>
  );
}

// ---------- Under the hood ----------

const STACK = ["Cloudflare Pages", "D1 (SQLite)", "R2", "Workers AI", "TypeScript", "React", "MCP", "Playwright", "Proxmox LXC", "ClickUp API", "Telegram bot"];

export function UnderTheHood({ ops }: { ops?: PublicSummary["ops"] }) {
  const cards = [
    { h: "One queue, many agents", d: "Claims are a single atomic SQL statement in D1, so two agents can never take the same job. Each claim is a lease that expires if the agent dies." },
    { h: "Any agent can join", d: "A stateless MCP server plus a REST twin. Claude Code, Codex, Gemini CLI, Kimi and Mistral Vibe all connect with their own bearer token, and the token decides who they are." },
    { h: "Real browsers, residential IP", d: "A runner on a home Linux box starts each CLI headless with Playwright, a virtual display and a residential connection, so applications look like a person's." },
    { h: "Guardrails, not vibes", d: "Per-ATS pacing and per-company limits, a cached copy of the tracker so API limits never bite, and a Telegram control room for anything that needs a person." },
  ];
  return (
    <section className="hood">
      <div className="hood-head">
        <h2>Under the hood</h2>
        <p>
          Built end to end as a real multi-agent system, not a demo. Open source, in production, and doing the work you see above.
        </p>
      </div>
      {ops && ops.runs > 0 && (
        <ul className="ops">
          <li>
            <b>{ops.runsOk.toLocaleString()}</b>
            <span>agent runs completed</span>
          </li>
          <li>
            <b>{ops.agentHours.toLocaleString()}</b>
            <span>agent-hours of work</span>
          </li>
          <li>
            <b>{ops.claims.toLocaleString()}</b>
            <span>jobs claimed</span>
          </li>
        </ul>
      )}
      <div className="hood-grid">
        {cards.map((c) => (
          <div key={c.h} className="hood-card">
            <h3>{c.h}</h3>
            <p>{c.d}</p>
          </div>
        ))}
      </div>
      <ul className="chips stack">
        {STACK.map((s) => (
          <li key={s} className="chip">
            {s}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------- About ----------

export function About({ repo }: { repo: string }) {
  return (
    <section className="about">
      <div>
        <h2>Built by Preston Zen</h2>
        <p>
          I build production AI agents and LLM systems: agent runtimes, tool and MCP servers, voice agents and the plumbing that keeps them reliable. This hub is
          one of my own projects, running a real job search. I'm looking for a remote AI engineering role, so if this looks like how you'd want your team to
          work, let's talk.
        </p>
      </div>
      <div className="about-links">
        <a className="btn" href={repo} target="_blank" rel="noreferrer">
          View the code
        </a>
        <a className="btn alt" href="https://linkedtfin.com/in/prestonzen" target="_blank" rel="noreferrer">
          LinkedIn
        </a>
        <a className="btn alt" href="mailto:contact@prestonzen.com">
          contact@prestonzen.com
        </a>
      </div>
    </section>
  );
}
