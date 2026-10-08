import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { agentColor, agentKey, agentLabel, sortAgents } from "../agents";
import type { PublicApplication } from "../types";

// ---------- small hooks ----------

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Animate a number from 0 to `target` once (skipped for reduced motion). */
export function useCountUp(target: number, ms = 900): number {
  const [v, setV] = useState(() => (reducedMotion() ? target : 0));
  useEffect(() => {
    if (reducedMotion()) return setV(target);
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      setV(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const fmtDay = (iso: string, opts: Intl.DateTimeFormatOptions) => new Date(`${iso}T12:00:00`).toLocaleDateString([], opts);

/** Axis with ~4 round steps that just clears `v` (54 → 0/20/40/60, not 0..100). */
function niceScale(v: number): { max: number; ticks: number[] } {
  const raw = Math.max(1, v) / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const max = Math.ceil(Math.max(1, v) / step) * step;
  return { max, ticks: Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step) };
}

export function Card({ title, aside, children, className = "" }: { title: string; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      <div className="card-head">
        <h2>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Key({ name }: { name: string }) {
  return <i className="key" style={{ background: agentColor(name) }} aria-hidden="true" />;
}

// ---------- Applications per day: stacked by agent ----------

type Day = { date: string; count: number; byAgent: Record<string, number> };

export function DailyChart({ days: raw }: { days: (Omit<Day, "byAgent"> & { byAgent?: Record<string, number> })[] }) {
  // Older summaries had no per-agent split; show those days as one "Unknown" segment.
  const days: Day[] = raw.map((d) => ({ ...d, byAgent: d.byAgent ?? { Unknown: d.count } }));
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const [table, setTable] = useState(false);
  const shown = days.slice(-30);
  const agents = sortAgents([...new Set(shown.flatMap((d) => Object.keys(d.byAgent)))]);
  const totals = Object.fromEntries(agents.map((a) => [a, shown.reduce((s, d) => s + (d.byAgent[a] ?? 0), 0)]));

  const H = 240;
  const M = { top: 24, right: 8, bottom: 28, left: 32 };
  const innerW = Math.max(0, width - M.left - M.right);
  const innerH = H - M.top - M.bottom;
  const { max, ticks } = niceScale(Math.max(1, ...shown.map((d) => d.count)));
  const band = shown.length ? innerW / shown.length : 0;
  const barW = Math.max(6, Math.min(56, band * 0.62));
  const y = (v: number) => innerH - (v / max) * innerH;

  const legend = (
    <ul className="legend" aria-label="Agents">
      {agents.map((a) => (
        <li key={a}>
          <Key name={a} />
          {agentLabel(a)} <b>{totals[a]}</b>
        </li>
      ))}
    </ul>
  );

  return (
    <Card
      title="Applications per day"
      className="wide chart-card"
      aside={
        <button className="ghost small-btn" onClick={() => setTable((t) => !t)} aria-pressed={table}>
          {table ? "Chart" : "Table"}
        </button>
      }
    >
      {legend}
      {shown.length === 0 ? (
        <p className="muted">No dated applications yet.</p>
      ) : table ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                {agents.map((a) => (
                  <th key={a} className="r">
                    {agentLabel(a)}
                  </th>
                ))}
                <th className="r">Total</th>
              </tr>
            </thead>
            <tbody>
              {[...shown].reverse().map((d) => (
                <tr key={d.date}>
                  <td>{fmtDay(d.date, { weekday: "short", month: "short", day: "numeric" })}</td>
                  {agents.map((a) => (
                    <td key={a} className="r">
                      {d.byAgent[a] ?? 0}
                    </td>
                  ))}
                  <td className="r">
                    <b>{d.count}</b>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart-wrap" ref={wrapRef} onPointerLeave={() => setHover(null)}>
          {width > 0 && (
            <svg width={width} height={H} role="img" aria-label={`Applications per day for the last ${shown.length} days, stacked by agent`}>
              <g transform={`translate(${M.left},${M.top})`}>
                {ticks.map((t) => (
                  <g key={t} transform={`translate(0,${y(t)})`}>
                    <line x1={0} x2={innerW} className={t === 0 ? "axis" : "gridline"} />
                    <text x={-8} dy="0.32em" textAnchor="end" className="tick">
                      {Number.isInteger(t) ? t : t.toFixed(1)}
                    </text>
                  </g>
                ))}
                {shown.map((d, i) => {
                  const cx = band * i + band / 2;
                  const x0 = cx - barW / 2;
                  let acc = 0;
                  const segs = agents.filter((a) => d.byAgent[a]);
                  const dim = hover && hover.i !== i;
                  return (
                    <g key={d.date} className={`bar${dim ? " dim" : ""}`} style={{ animationDelay: `${i * 40}ms` }}>
                      {segs.map((a, si) => {
                        const v = d.byAgent[a];
                        const top = y(acc + v);
                        const h = y(acc) - top;
                        acc += v;
                        const isTop = si === segs.length - 1;
                        const gap = isTop ? 0 : 2; // 2px surface gap between stacked segments
                        const hh = Math.max(0, h - gap);
                        const r = isTop ? Math.min(4, hh, barW / 2) : 0;
                        const yy = top + gap;
                        const path = `M${x0},${yy + hh} V${yy + r} Q${x0},${yy} ${x0 + r},${yy} H${x0 + barW - r} Q${x0 + barW},${yy} ${x0 + barW},${yy + r} V${yy + hh} Z`;
                        return <path key={a} d={isTop ? path : `M${x0},${top + gap} h${barW} v${hh} h${-barW} Z`} style={{ fill: agentColor(a) }} />;
                      })}
                      <text x={cx} y={y(d.count) - 7} textAnchor="middle" className="bar-total">
                        {d.count}
                      </text>
                      <text x={cx} y={innerH + 18} textAnchor="middle" className="tick">
                        {fmtDay(d.date, { month: "short", day: "numeric" })}
                      </text>
                      {/* Hit target: the whole band, taller than the bar. */}
                      <rect
                        x={band * i}
                        y={0}
                        width={band}
                        height={innerH}
                        className="hit"
                        tabIndex={0}
                        aria-label={`${fmtDay(d.date, { weekday: "long", month: "long", day: "numeric" })}: ${d.count} applications${segs
                          .map((a) => `, ${agentLabel(a)} ${d.byAgent[a]}`)
                          .join("")}`}
                        onPointerMove={(e) => {
                          const box = wrapRef.current!.getBoundingClientRect();
                          setHover({ i, x: e.clientX - box.left, y: e.clientY - box.top });
                        }}
                        onFocus={() => setHover({ i, x: M.left + cx, y: M.top + y(d.count) })}
                        onBlur={() => setHover(null)}
                      />
                    </g>
                  );
                })}
              </g>
            </svg>
          )}
          {hover && shown[hover.i] && <DayTooltip day={shown[hover.i]} agents={agents} x={hover.x} y={hover.y} width={width} />}
        </div>
      )}
    </Card>
  );
}

function DayTooltip({ day, agents, x, y, width }: { day: Day; agents: string[]; x: number; y: number; width: number }) {
  const left = Math.min(Math.max(x + 14, 8), Math.max(8, width - 200));
  const rows = agents.filter((a) => day.byAgent[a]);
  return (
    <div className="tooltip" style={{ left, top: Math.max(0, y - 20) }} role="status">
      <div className="tt-head">{fmtDay(day.date, { weekday: "short", month: "short", day: "numeric" })}</div>
      <div className="tt-total">
        <b>{day.count}</b> applications
      </div>
      {rows.map((a) => (
        <div key={a} className="tt-row">
          <i style={{ background: agentColor(a) }} aria-hidden="true" />
          <b>{day.byAgent[a]}</b>
          <span>{agentLabel(a)}</span>
          <small>{Math.round((day.byAgent[a] / day.count) * 100)}%</small>
        </div>
      ))}
    </div>
  );
}

// ---------- Agent leaderboard ----------

export function AgentBoard({ byAgent, online }: { byAgent: Record<string, number>; online: string[] }) {
  const entries = Object.entries(byAgent).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, n]) => s + n, 0) || 1;
  const max = Math.max(1, ...entries.map(([, n]) => n));
  const isOnline = (a: string) => online.map(agentKey).includes(agentKey(a));
  return (
    <Card title="The agents">
      <ol className="board">
        {entries.map(([name, n], i) => (
          <li key={name}>
            <span className="rank">{i + 1}</span>
            <span className="who">
              <Key name={name} />
              {agentLabel(name)}
              {isOnline(name) && (
                <span className="live-tag">
                  <i className="pulse" aria-hidden="true" />
                  working
                </span>
              )}
            </span>
            <span className="meter" title={`${n} applications (${Math.round((n / total) * 100)}%)`}>
              <span style={{ width: `${(n / max) * 100}%`, background: agentColor(name) }} />
            </span>
            <span className="num">{n}</span>
            <span className="pct">{Math.round((n / total) * 100)}%</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

// ---------- Where applications go (ATS) ----------

export function PlatformBars({ byPlatform }: { byPlatform: Record<string, number> }) {
  const rows = Object.entries(byPlatform).sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((s, [, n]) => s + n, 0) || 1;
  const max = Math.max(1, ...rows.map(([, n]) => n));
  return (
    <Card title="Where they applied">
      <ul className="hbars">
        {rows.map(([name, n]) => (
          <li key={name} tabIndex={0} title={`${name}: ${n} (${Math.round((n / total) * 100)}%)`}>
            <span className="lbl">{name}</span>
            <span className="track">
              <span style={{ width: `${(n / max) * 100}%` }} />
            </span>
            <span className="num">{n}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ---------- Funnel ----------

export function Funnel({ items }: { items: { label: string; value: number }[] }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <Card title="Pipeline">
      <ol className="funnel">
        {items.map((i) => (
          <li key={i.label}>
            <span className="lbl">{i.label}</span>
            <span className="track">
              <span style={{ width: `${Math.max(i.value ? 2 : 0, (i.value / max) * 100)}%` }} />
            </span>
            <span className="num">{i.value}</span>
          </li>
        ))}
      </ol>
      <p className="muted small">Replies, screens and offers move up this list as they happen.</p>
    </Card>
  );
}

// ---------- Activity feed ----------

function relDay(iso: string | null): string {
  if (!iso) return "—";
  const today = new Date();
  const d = new Date(`${iso}T12:00:00`);
  const diff = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (diff <= 0) return "today";
  if (diff === 1) return "yesterday";
  if (diff < 7) return `${diff} days ago`;
  return fmtDay(iso, { month: "short", day: "numeric" });
}

export function ActivityFeed({ items }: { items: PublicApplication[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 12);
  return (
    <Card title="Latest applications" className="wide" aside={<span className="muted small">{items.length} most recent</span>}>
      <ol className="activity">
        {shown.map((a, i) => (
          <li key={i}>
            <Key name={a.appliedBy ?? "unknown"} />
            <span className="what">
              <b>{a.company}</b>
              <span className="muted">{a.role}</span>
            </span>
            <span className="meta">
              <span className="chip">{a.platform ?? "Other"}</span>
              <span className="by">{agentLabel(a.appliedBy)}</span>
              <span className={`pill s-${a.status.replace(/\W+/g, "-")}`}>{a.status}</span>
              <span className="when">{relDay(a.appliedOn)}</span>
            </span>
          </li>
        ))}
      </ol>
      {items.length > 12 && (
        <button className="ghost more" onClick={() => setAll((v) => !v)}>
          {all ? "Show less" : `Show all ${items.length}`}
        </button>
      )}
    </Card>
  );
}
