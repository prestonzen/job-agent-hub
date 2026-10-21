import { Fragment, useEffect, useMemo, useState } from "react";
import { addComment, getAdminTasks, getMe, login, logout, setStatus } from "../api";
import { STATUSES, type AdminTask } from "../types";
import Analytics from "./Analytics";
import Assisted from "./Assisted";
import Bounty from "./Bounty";
import CommandCenter from "./CommandCenter";
import Connect from "./Connect";
import Alerts from "./Alerts";
import Resumes from "./Resumes";
import Autopilot from "./Autopilot";
import RunAgents from "./RunAgents";

const TABS = [
  { id: "hub", label: "Command center" },
  { id: "analytics", label: "Analytics" },
  { id: "assisted", label: "Assisted" },
  { id: "agents", label: "Agent manager" },
  { id: "run", label: "Run agents" },
  { id: "resumes", label: "Resumes" },
  { id: "alerts", label: "Replies & alerts" },
  { id: "bounty", label: "Bug bounty" },
  { id: "pipeline", label: "Pipeline" },
  { id: "connect", label: "Connect agents" },
] as const;
const GROUPS=[
 {label:"Overview",ids:["hub"]}, {label:"Applications",ids:["pipeline","assisted","resumes","analytics"]},
 {label:"Replies",ids:["alerts"]}, {label:"Cyber",ids:["bounty"]}, {label:"Agents",ids:["agents","run","connect"]}
] as const;
type Tab = (typeof TABS)[number]["id"];

const tabFromHash = (): Tab => (TABS.find((t) => `#${t.id}` === window.location.hash)?.id ?? "hub");

export default function Admin() {
  const [user, setUser] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [tab, setTab] = useState<Tab>(tabFromHash);

  useEffect(() => {
    getMe()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setChecked(true));
    const onHash = () => {setTab(tabFromHash());window.scrollTo({top:0});};
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (!checked) return <p className="notice">Loading…</p>;
  if (!user) return <Login onDone={setUser} />;

  const group=GROUPS.find(g=>g.ids.some(id=>id===tab))??GROUPS[0];
  return (
    <main className="admin-main">
      <section className="hero compact">
        <h1>Admin</h1>
        <p>
          Signed in as <b>{user}</b>. Changes write to Huly (mirrored to ClickUp while both are in use).{" "}
          <button className="ghost" onClick={() => void logout().then(() => setUser(null))}>
            Sign out
          </button>
        </p>
        <nav className="tabs" aria-label="Admin sections">
          {GROUPS.map(g=><a key={g.label} href={`#${g.ids[0]}`} className={g===group?'on':''} aria-current={g===group?'page':undefined}>{g.label}</a>)}
        </nav>
        {group.ids.length>1&&<nav className="admin-subnav" aria-label={`${group.label} views`}>{TABS.filter(t=>group.ids.some(id=>id===t.id)).map(t=><a key={t.id} href={`#${t.id}`} className={tab===t.id?'on':''} aria-current={tab===t.id?'page':undefined}>{t.label}</a>)}</nav>}
      </section>
      {tab === "hub" && <CommandCenter />}
      {tab === "analytics" && <Analytics />}
      {tab === "assisted" && <Assisted />}
      {tab === "agents" && <Autopilot />}
      {tab === "run" && <RunAgents />}
      {tab === "resumes" && <Resumes />}
      {tab === "alerts" && <Alerts />}
      {tab === "bounty" && <Bounty />}
      {tab === "pipeline" && <Pipeline />}
      {tab === "connect" && <Connect />}
    </main>
  );
}

function Login({ onDone }: { onDone: (user: string) => void }) {
  const [token, setToken] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await login(token);
      onDone((await getMe()).user);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <section className="hero compact">
        <h1>Admin sign-in</h1>
        <p>Paste the admin token. You stay signed in on this browser for 30 days.</p>
      </section>
      <form className="card login" onSubmit={(e) => void submit(e)}>
        <label htmlFor="admin-token">Admin token</label>
        <input
          id="admin-token"
          type="password"
          autoComplete="current-password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          required
        />
        <button disabled={busy || !token}>{busy ? "Checking…" : "Sign in"}</button>
        {err && <p className="err">{err}</p>}
      </form>
    </main>
  );
}

function Pipeline() {
  const [tasks, setTasks] = useState<AdminTask[]>([]);
  const [demo, setDemo] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [page,setPage]=useState(0);
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
      <input className="search" placeholder="Filter by company or role…" value={q} onChange={(e) => {setQ(e.target.value);setPage(0)}} />
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
            {shown.slice(page*20,page*20+20).map((t) => (
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
                      Open ↗
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
        <div className="row-actions"><button disabled={page===0} onClick={()=>setPage(p=>p-1)}>Previous</button><span>Page {page+1} · {shown.length} applications</span><button disabled={(page+1)*20>=shown.length} onClick={()=>setPage(p=>p+1)}>Next</button></div>
      </section>
    </>
  );
}
