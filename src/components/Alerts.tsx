import { useEffect, useState } from "react";
import { getInbound, recoverReplyAlert, sendDigestNow, testTelegram, type InboundEmail } from "../api";

const ICON: Record<string, string> = { rejection: "❌", interview: "🗓️", assessment: "📝", offer: "🎉", confirmation: "📨", recruiter: "👋", onboarding: "📋", other: "✉️" };

/** Telegram alerts and the recruiter-reply log (from the Gmail reply tracker). */
export default function Alerts() {
  const [emails, setEmails] = useState<InboundEmail[]>([]);
  const [showAll,setShowAll]=useState(false);
  const [limit,setLimit]=useState(12);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    getInbound().then((r) => setEmails(r.emails)).catch((e: Error) => setMsg(e.message));
  }, []);

  const run = async (fn: () => Promise<{ ok: boolean; error: string | null }>, ok: string) => {
    try {
      const r = await fn();
      setMsg(r.ok ? ok : r.error);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>Telegram</h2>
        </div>
        <p className="muted small">
          Posts to the Kaizen Apps Operations group, in a "Job Agent Hub" topic: jobs that need you, finished runs, recruiter replies, and the
          daily digest (add one under Run agents → Schedules).
        </p>
        <div className="row-actions">
          <button className="small-btn" onClick={() => void run(testTelegram, "Test message sent.")}>Send test message</button>
          <button className="ghost small-btn" onClick={() => void run(sendDigestNow, "Digest sent.")}>Send digest now</button>
        </div>
        {msg && <p className="small">{msg}</p>}
      </section>

      <section className="card wide">
        <div className="card-head">
          <h2>Recruiter replies</h2>
          <label className="small"><input type="checkbox" checked={showAll} onChange={e=>setShowAll(e.target.checked)}/> Include confirmations and other mail</label>
        </div>
        {emails.length === 0 ? (
          <p className="muted">No replies tracked yet. Install integrations/gmail-reply-tracker.gs (see the README).</p>
        ) : (
          <ul className="activity">
            {emails.filter(e=>showAll||!["confirmation","other","rejection"].includes(e.category)).slice(0,limit).map((e) => (
              <li key={e.message_id}>
                <span aria-hidden="true">{ICON[e.category] ?? "✉️"}</span>
                <span className="what">
                  <b>{e.subject}</b>
                  <span className="muted">{e.summary}</span>
                </span>
                <span className="meta">
                  <span className="chip">{e.category}</span>
                  <span>{e.task_id ? e.action : "unmatched"}</span>
                  {e.delivery_state!=='sent'&&<button className="ghost small-btn" onClick={()=>{void recoverReplyAlert(e.message_id).then(r=>{setMsg(r.state==='sent'?`Sent · Telegram #${r.receipt}`:r.error??r.state);return getInbound();}).then(r=>setEmails(r.emails)).catch(e=>setMsg(e.message));}}>Notify on Telegram</button>}
                  <span title={e.delivery_error ?? undefined}>Telegram: {e.delivery_state ?? "legacy · receipt unavailable"}{e.telegram_receipt ? ` #${e.telegram_receipt}` : ""}</span>
                  <span className="when">{new Date(e.at).toLocaleDateString([], { month: "short", day: "numeric" })}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <button className="ghost" onClick={()=>setLimit(n=>n===12?50:12)}>{limit===12?'Show up to 50 replies':'Show recent 12'}</button>
      </section>
    </>
  );
}
