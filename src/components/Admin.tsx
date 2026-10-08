import { Fragment, useEffect, useMemo, useState } from "react";
import { addComment, getAdminTasks, getMe, setStatus } from "../api";
import { STATUSES, type AdminTask } from "../types";
import CommandCenter from "./CommandCenter";
import Connect from "./Connect";

const TABS = [
  { id: "hub", label: "Command center" },
  { id: "pipeline", label: "Pipeline" },
  { id: "connect", label: "Connect agents" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const tabFromHash = (): Tab => (TABS.find((t) => `#${t.id}` === window.location.hash)?.id ?? "hub");

export default function Admin() {
  const [email, setEmail] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(tabFromHash);

  useEffect(() => {
    getMe()
      .then((r) => setEmail(r.email))
      .catch((e: Error) => setErr(e.message));
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (err)
    return (
      <main>
        <p className="notice">
          Admin API said: <b>{err}</b>. This area is protected by Cloudflare Access — sign in with an allowed email.
        </p>
      </main>
    );
  if (!email) return <p className="notice">Loading…</p>;

  return (
    <main>
      <section className="hero compact">
        <h1>Admin</h1>
        <p>
          Signed in as <b>{email}</b>. Changes write straight to ClickUp.
        </p>
        <nav className="tabs" aria-label="Admin sections">
          {TABS.map((t) => (
            <a key={t.id} href={`#${t.id}`} className={tab === t.id ? "on" : ""} aria-current={tab === t.id ? "page" : undefined}>
              {t.label}
            </a>
          ))}
        </nav>
      </section>
      {tab === "hub" && <CommandCenter />}
      {tab === "pipeline" && <Pipeline />}
      {tab === "connect" && <Connect />}
    </main>
  );
}

function Pipeline() {
  const [tasks, setTasks] = useState<AdminTask[]>([]);
  const [demo, setDemo] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState("");

  async function load() {
    try {
      const r = await getAdminTasks();
      setTasks(r.tasks);
      setDemo(r.demo);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  const shown = useMemo(
    () => tasks.filter((t) => t.name.toLowerCase().includes(q.toLowerCase())),
    [tasks, q],
  );

  async function changeStatus(t: AdminTask, status: string) {
    setTasks((all) => all.map((x) => (x.id === t.id ? { ...x, status } : x)));
    try {
      await setStatus(t.id, status);
    } catch (e) {
      setErr((e as Error).message);
      void load();
    }
  }

  async function submitNote(t: AdminTask) {
    if (!note.trim()) return;
    await addComment(t.id, note.trim());
    setNote("");
    setOpen(null);
  }

  return (
    <>
      {err && <p className="notice">Error: {err}</p>}
      <input className="search" placeholder="Filter by company or role…" value={q} onChange={(e) => setQ(e.target.value)} />
      {demo && <span className="badge"> Demo data</span>}
      <section className="card wide">
        <table>
          <thead>
            <tr>
              <th>Task</th>
              <th>Platform</th>
              <th>By</th>
              <th>Date</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => (
              <Fragment key={t.id}>
                <tr>
                  <td>
                    {t.name}
                    {t.nextAction && <div className="sub">{t.nextAction}</div>}
                  </td>
                  <td>{t.platform ?? "—"}</td>
                  <td>{t.appliedBy ?? "—"}</td>
                  <td>{t.appliedOn ?? "—"}</td>
                  <td>
                    <select value={t.status} onChange={(e) => void changeStatus(t, e.target.value)} aria-label={`Status of ${t.name}`}>
                      {[...new Set([...STATUSES, t.status])].map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </td>
                  <td className="r nowrap">
                    <button className="ghost" onClick={() => setOpen(open === t.id ? null : t.id)}>
                      Note
                    </button>{" "}
                    <a href={t.url} target="_blank" rel="noreferrer">
                      ClickUp ↗
                    </a>
                  </td>
                </tr>
                {open === t.id && (
                  <tr>
                    <td colSpan={6}>
                      <div className="note-row">
                        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a comment to this task…" />
                        <button onClick={() => void submitNote(t)}>Add</button>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
