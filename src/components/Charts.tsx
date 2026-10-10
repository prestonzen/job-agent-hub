import { useLayoutEffect, useRef, useState } from "react";

/** Width of an element, tracked with a ResizeObserver (SVG charts size themselves to their card). */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
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

/** ~4 round axis steps that just clear `v`. */
export function niceScale(v: number): { max: number; ticks: number[] } {
  const raw = Math.max(1, v) / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = Math.max(1, [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag);
  const max = Math.ceil(Math.max(1, v) / step) * step;
  return { max, ticks: Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step) };
}

export interface Series {
  key: string;
  label: string;
  color: string;
}
export type StackRow = { label: string; sub?: string; values: Record<string, number> };

/** Stacked columns with a hover tooltip. Generic over the series so it serves any breakdown. */
export function StackedColumns({ rows, series, height = 220, ariaLabel }: { rows: StackRow[]; series: Series[]; height?: number; ariaLabel: string }) {
  const [wrap, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const M = { top: 12, right: 6, bottom: 26, left: 30 };
  const innerW = Math.max(0, width - M.left - M.right);
  const innerH = height - M.top - M.bottom;
  const totals = rows.map((r) => series.reduce((s, x) => s + (r.values[x.key] ?? 0), 0));
  const { max, ticks } = niceScale(Math.max(1, ...totals));
  const band = rows.length ? innerW / rows.length : 0;
  const barW = Math.max(3, Math.min(34, band * 0.7));
  const y = (v: number) => innerH - (v / max) * innerH;
  const every = Math.max(1, Math.ceil(rows.length / Math.max(1, Math.floor(innerW / 44))));

  return (
    <div className="chart-wrap" ref={wrap} onPointerLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel}>
          <g transform={`translate(${M.left},${M.top})`}>
            {ticks.map((t) => (
              <g key={t} transform={`translate(0,${y(t)})`}>
                <line x1={0} x2={innerW} className={t === 0 ? "axis" : "gridline"} />
                <text x={-6} dy="0.32em" textAnchor="end" className="tick">
                  {t}
                </text>
              </g>
            ))}
            {rows.map((r, i) => {
              const cx = band * i + band / 2;
              let acc = 0;
              return (
                <g key={i} className={`bar${hover && hover.i !== i ? " dim" : ""}`} style={{ animationDelay: `${Math.min(i, 40) * 14}ms` }}>
                  {series.map((s) => {
                    const v = r.values[s.key] ?? 0;
                    if (!v) return null;
                    const top = y(acc + v);
                    const h = Math.max(1, y(acc) - top - 1);
                    acc += v;
                    return <rect key={s.key} x={cx - barW / 2} y={top + 1} width={barW} height={h} rx={Math.min(3, barW / 2)} style={{ fill: s.color }} />;
                  })}
                  {i % every === 0 && (
                    <text x={cx} y={innerH + 17} textAnchor="middle" className="tick">
                      {r.label}
                    </text>
                  )}
                  <rect
                    x={band * i}
                    y={0}
                    width={band}
                    height={innerH}
                    className="hit"
                    onPointerMove={(e) => {
                      const b = wrap.current!.getBoundingClientRect();
                      setHover({ i, x: e.clientX - b.left, y: e.clientY - b.top });
                    }}
                  />
                </g>
              );
            })}
          </g>
        </svg>
      )}
      {hover && rows[hover.i] && (
        <div className="tooltip" style={{ left: Math.min(Math.max(hover.x + 14, 8), Math.max(8, width - 190)), top: Math.max(0, hover.y - 20) }} role="status">
          <div className="tt-head">{rows[hover.i].sub ?? rows[hover.i].label}</div>
          {series.map((s) => (
            <div key={s.key} className="tt-row">
              <i style={{ background: s.color }} aria-hidden="true" />
              <b>{rows[hover.i].values[s.key] ?? 0}</b>
              <span>{s.label}</span>
              <small />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Tiny area/line chart for a trend with no axes (e.g. API calls per day). */
export function Spark({ values, color = "var(--accent)", height = 54 }: { values: number[]; color?: string; height?: number }) {
  const [wrap, width] = useWidth<HTMLDivElement>();
  const max = Math.max(1, ...values);
  const n = Math.max(1, values.length - 1);
  const pts = values.map((v, i) => [(i / n) * Math.max(0, width - 4) + 2, height - 4 - (v / max) * (height - 10)] as const);
  const line = pts.map(([x, yy], i) => `${i ? "L" : "M"}${x.toFixed(1)},${yy.toFixed(1)}`).join(" ");
  return (
    <div ref={wrap} className="spark">
      {width > 0 && values.length > 1 && (
        <svg width={width} height={height} role="img" aria-label={`Trend, latest ${values[values.length - 1]}`}>
          <path d={`${line} L${width - 2},${height} L2,${height} Z`} style={{ fill: color, opacity: 0.14 }} />
          <path d={line} style={{ stroke: color, fill: "none", strokeWidth: 2, strokeLinejoin: "round", strokeLinecap: "round" }} />
          <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={3.5} style={{ fill: color }} />
        </svg>
      )}
    </div>
  );
}
