import { useEffect, useState } from "react";
import { deleteResume, getResumes, pickResume, updateResume, uploadResume, type Resume } from "../api";

const kb = (n: number) => `${Math.round(n / 1024)} KB`;

/** Tailored resume variants; agents pick one per job by role title (get_resume). */
export default function Resumes() {
  const [list, setList] = useState<Resume[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState("Senior Forward Deployed Engineer");
  const [probeResult, setProbeResult] = useState<string | null>(null);

  const load = () => getResumes().then((r) => setList(r.resumes)).catch((e: Error) => setMsg(e.message));
  useEffect(() => { void load(); }, []);

  async function upload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    form.set("isDefault", (e.currentTarget.elements.namedItem("isDefault") as HTMLInputElement).checked ? "true" : "false");
    setBusy(true);
    try {
      await uploadResume(form);
      (e.target as HTMLFormElement).reset();
      setMsg("Uploaded.");
      void load();
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    const r = await pickResume(probe).catch(() => null);
    setProbeResult(r ? `→ ${r.name}${r.matched.length ? ` (matched: ${r.matched.join(", ")})` : " (default, no tag matched)"}` : "Resume bank is empty.");
  }

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>Resume bank</h2>
          <span className="muted small">agents call get_resume with the job title</span>
        </div>
        {list.length === 0 ? (
          <p className="muted">No resumes yet. Upload your main one first; it becomes the default.</p>
        ) : (
          <ul className="resume-list">
            {list.map((r) => (
              <ResumeRow key={r.id} r={r} onChange={load} />
            ))}
          </ul>
        )}
        <div className="probe">
          <label>
            Test a role title
            <input value={probe} onChange={(e) => setProbe(e.target.value)} />
          </label>
          <button className="ghost small-btn" onClick={() => void test()}>Which resume?</button>
          {probeResult && <span className="small">{probeResult}</span>}
        </div>
      </section>

      <form className="card launcher" onSubmit={(e) => void upload(e)}>
        <div className="card-head">
          <h2>Add a resume</h2>
        </div>
        <label>File (PDF or DOCX, ≤5 MB)<input name="file" type="file" accept=".pdf,.docx" required /></label>
        <label>Name<input name="name" placeholder="e.g. Forward Deployed / Solutions" /></label>
        <label>
          Role keywords (comma-separated)
          <input name="tags" placeholder="forward deployed, solutions, customer, field" />
        </label>
        <label className="check"><input name="isDefault" type="checkbox" /> Use as default when no keyword matches</label>
        <button disabled={busy}>{busy ? "Uploading…" : "Upload"}</button>
      </form>
      {msg && <p className="small muted">{msg}</p>}
    </>
  );
}

function ResumeRow({ r, onChange }: { r: Resume; onChange: () => void }) {
  const [tags, setTags] = useState(r.tags.join(", "));
  const dirty = tags !== r.tags.join(", ");
  return (
    <li>
      <div className="resume-head">
        <b>{r.name}</b>
        {r.isDefault && <span className="pill">default</span>}
        <span className="muted small">{r.filename} · {kb(r.size)}</span>
      </div>
      <div className="resume-tags">
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="role keywords" aria-label={`Keywords for ${r.name}`} />
        {dirty && <button className="small-btn" onClick={() => void updateResume(r.id, { tags }).then(onChange)}>Save</button>}
        <a className="small" href={`/api/admin/resumes/${r.id}/file`}>Download</a>
        {!r.isDefault && <button className="ghost small-btn" onClick={() => void updateResume(r.id, { isDefault: true }).then(onChange)}>Make default</button>}
        <button className="ghost small-btn danger" onClick={() => window.confirm(`Delete ${r.name}?`) && void deleteResume(r.id).then(onChange)}>Delete</button>
      </div>
    </li>
  );
}
