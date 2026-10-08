import { useEffect, useState } from "react";
import { getPacing, savePacing, type PacingLive, type PacingPolicy } from "../api";

const mins = (iso: string | null) => (iso ? Math.max(1, Math.ceil((Date.parse(iso) - Date.now()) / 60_000)) : null);

/** Live load per hiring system vs. the limits every agent's claims are held to; editable. */
export default function Pacing() {
  const [policy, setPolicy] = useState<PacingPolicy | null>(null);
  const [live, setLive] = useState<PacingLive | null>(null);
  const [edit, setEdit] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () =>
    getPacing()
      .then((r) => {
        setPolicy(r.policy);
        setLive(r.live);
      })
      .catch((e: Error) => setMsg(e.message));
  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 20_000);
    return () => clearInterval(t);
  }, []);

  if (!policy || !live) return null;

  const setAts = (k: string, f: keyof PacingPolicy["ats"][string], v: number) =>
    setPolicy({ ...policy, ats: { ...policy.ats, [k]: { ...policy.ats[k], [f]: v } } });

  async function save() {
    try {
      await savePacing(policy!);
      setEdit(false);
      setMsg("Saved. Applies to the next claim.");
      void load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  const rows = [...new Set([...live.ats.map((a) => a.ats), ...Object.keys(policy.ats)])].filter((k) => edit || k !== "default");

  return (
    <section className="card wide">
      <div className="card-head">
        <h2>Pacing (all agents)</h2>
        <div className="row-actions">
          <span className="muted small">
            {live.todayTotal}/{live.globalPerDay} applications in the last 24 h · {policy.companyConcurrent} at a time per company
          </span>
          {edit ? (
            <>
              <button className="ghost small-btn" onClick={() => { setEdit(false); void load(); }}>Cancel</button>
              <button className="small-btn" onClick={() => void save()}>Save</button>
            </>
          ) : (
            <button className="ghost small-btn" onClick={() => setEdit(true)}>Edit limits</button>
          )}
        </div>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>System</th>
              <th className="r">In progress</th>
              <th className="r">Last 24 h</th>
              <th className="r">Gap (min)</th>
              <th>Next slot</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((k) => {
              const l = live.ats.find((a) => a.ats === k);
              const p = policy.ats[k] ?? policy.ats.default;
              const full = l && (l.active >= p.concurrent || l.today + l.active >= p.perDay);
              return (
                <tr key={k}>
                  <td className="cap">{k === "default" ? "Everything else" : k}</td>
                  <td className="r">
                    {l?.active ?? 0}/{edit ? <input className="num-in" type="number" min={0} max={10} value={p.concurrent} onChange={(e) => setAts(k, "concurrent", +e.target.value)} /> : p.concurrent}
                  </td>
                  <td className="r">
                    {l?.today ?? 0}/{edit ? <input className="num-in" type="number" min={0} max={200} value={p.perDay} onChange={(e) => setAts(k, "perDay", +e.target.value)} /> : p.perDay}
                  </td>
                  <td className="r">{edit ? <input className="num-in" type="number" min={0} max={240} value={p.minGapMin} onChange={(e) => setAts(k, "minGapMin", +e.target.value)} /> : p.minGapMin}</td>
                  <td>{full ? <span className="pill warn">full</span> : mins(l?.nextSlotAt ?? null) ? `in ${mins(l!.nextSlotAt)} min` : <span className="pill s-not-started">open</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {edit && (
        <div className="inline-fields">
          <label>Per company at once <input className="num-in" type="number" min={1} max={5} value={policy.companyConcurrent} onChange={(e) => setPolicy({ ...policy, companyConcurrent: +e.target.value })} /></label>
          <label>Company cooldown (days) <input className="num-in" type="number" min={0} max={180} value={policy.companyCooldownDays} onChange={(e) => setPolicy({ ...policy, companyCooldownDays: +e.target.value })} /></label>
          <label>Daily total <input className="num-in" type="number" min={1} max={500} value={policy.globalPerDay} onChange={(e) => setPolicy({ ...policy, globalPerDay: +e.target.value })} /></label>
        </div>
      )}
      {msg && <p className="small muted">{msg}</p>}
    </section>
  );
}
