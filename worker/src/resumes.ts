import { HttpError } from "./clickup";
import { db } from "./db";
import type { Env } from "./types";

/**
 * Resume bank: tailored resume variants in R2 (private bucket), tagged with role keywords.
 * Agents call get_resume with the job title and get the best match; runners download every
 * variant into each run's folder so the browser can upload it without wider file access.
 */

const SCHEMA = `CREATE TABLE IF NOT EXISTS resumes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  filename TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL
)`;

const MAX_BYTES = 5 * 1024 * 1024;
const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

let ready = false;
async function rdb(env: Env) {
  const d = await db(env);
  if (!ready) {
    await d.prepare(SCHEMA).run();
    ready = true;
  }
  return d;
}

export interface Resume {
  id: number;
  name: string;
  filename: string;
  tags: string[];
  isDefault: boolean;
  size: number;
  contentType: string;
  uploadedAt: string;
}

interface Row { id: number; name: string; filename: string; tags: string; is_default: number; size: number; content_type: string; r2_key: string; uploaded_at: number }
const toResume = (r: Row): Resume => ({
  id: r.id, name: r.name, filename: r.filename, tags: r.tags ? r.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
  isDefault: !!r.is_default, size: r.size, contentType: r.content_type, uploadedAt: new Date(r.uploaded_at).toISOString(),
});
const cleanTags = (t: string | string[] | undefined) =>
  [...new Set((Array.isArray(t) ? t : (t ?? "").split(",")).map((x) => x.trim().toLowerCase()).filter(Boolean))].join(",");

function bucket(env: Env): R2Bucket {
  if (!env.RESUMES) throw new HttpError(503, "RESUMES bucket binding is missing");
  return env.RESUMES;
}

export async function listResumes(env: Env): Promise<Resume[]> {
  const { results } = await (await rdb(env)).prepare("SELECT * FROM resumes ORDER BY is_default DESC, name").all<Row>();
  return results.map(toResume);
}

export async function uploadResume(
  env: Env,
  meta: { name: string; filename: string; tags?: string | string[]; isDefault?: boolean },
  body: ArrayBuffer,
): Promise<Resume> {
  const ext = meta.filename.toLowerCase().split(".").pop() ?? "";
  if (!TYPES[ext]) throw new HttpError(400, "only .pdf or .docx resumes");
  if (body.byteLength === 0 || body.byteLength > MAX_BYTES) throw new HttpError(400, "file must be 1 byte to 5 MB");
  const filename = meta.filename.replace(/[^\w.\- ]+/g, "_").slice(0, 120);
  const key = `resumes/${crypto.randomUUID()}-${filename}`;
  await bucket(env).put(key, body, { httpMetadata: { contentType: TYPES[ext] } });
  const d = await rdb(env);
  const count = (await d.prepare("SELECT COUNT(*) AS n FROM resumes").first<{ n: number }>())?.n ?? 0;
  const isDefault = meta.isDefault || count === 0;
  if (isDefault) await d.prepare("UPDATE resumes SET is_default = 0").run();
  const r = await d
    .prepare("INSERT INTO resumes (name, filename, tags, is_default, size, content_type, r2_key, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *")
    .bind(meta.name.trim().slice(0, 80) || filename, filename, cleanTags(meta.tags), isDefault ? 1 : 0, body.byteLength, TYPES[ext], key, Date.now())
    .first<Row>();
  return toResume(r!);
}

export async function updateResume(env: Env, id: number, patch: { name?: string; tags?: string | string[]; isDefault?: boolean }): Promise<Resume> {
  const d = await rdb(env);
  const cur = await d.prepare("SELECT * FROM resumes WHERE id = ?").bind(id).first<Row>();
  if (!cur) throw new HttpError(404, `no resume ${id}`);
  if (patch.isDefault) await d.prepare("UPDATE resumes SET is_default = 0").run();
  const r = await d
    .prepare("UPDATE resumes SET name = ?, tags = ?, is_default = ? WHERE id = ? RETURNING *")
    .bind(patch.name?.trim().slice(0, 80) || cur.name, patch.tags !== undefined ? cleanTags(patch.tags) : cur.tags, patch.isDefault ? 1 : cur.is_default, id)
    .first<Row>();
  return toResume(r!);
}

export async function deleteResume(env: Env, id: number): Promise<void> {
  const d = await rdb(env);
  const cur = await d.prepare("SELECT r2_key FROM resumes WHERE id = ?").bind(id).first<{ r2_key: string }>();
  if (!cur) throw new HttpError(404, `no resume ${id}`);
  await bucket(env).delete(cur.r2_key);
  await d.prepare("DELETE FROM resumes WHERE id = ?").bind(id).run();
}

/** The file itself, for attaching to an email. */
export async function resumeBytes(env: Env, id: number): Promise<{ filename: string; contentType: string; bytes: ArrayBuffer }> {
  const cur = await (await rdb(env)).prepare("SELECT * FROM resumes WHERE id = ?").bind(id).first<Row>();
  if (!cur) throw new HttpError(404, `no resume ${id}`);
  const obj = await bucket(env).get(cur.r2_key);
  if (!obj) throw new HttpError(404, "file missing from storage");
  return { filename: cur.filename, contentType: cur.content_type, bytes: await obj.arrayBuffer() };
}

export async function resumeFile(env: Env, id: number): Promise<Response> {
  const cur = await (await rdb(env)).prepare("SELECT * FROM resumes WHERE id = ?").bind(id).first<Row>();
  if (!cur) throw new HttpError(404, `no resume ${id}`);
  const obj = await bucket(env).get(cur.r2_key);
  if (!obj) throw new HttpError(404, "file missing from storage");
  return new Response(obj.body, {
    headers: {
      "Content-Type": cur.content_type,
      "Content-Disposition": `attachment; filename="${cur.filename.replace(/"/g, "")}"`,
      "Cache-Control": "private, no-store",
    },
  });
}

/** Best variant for a role title: most tag phrases found in the title; ties and no match → default. */
export async function pickResume(env: Env, role: string): Promise<(Resume & { matched: string[] }) | null> {
  const all = await listResumes(env);
  if (!all.length) return null;
  const title = ` ${role.toLowerCase().replace(/[^a-z0-9+#]+/g, " ")} `;
  let best: (Resume & { matched: string[] }) | null = null;
  for (const r of all) {
    const matched = r.tags.filter((t) => title.includes(` ${t.replace(/[^a-z0-9+#]+/g, " ").trim()} `));
    if (!best || matched.length > best.matched.length || (matched.length === best.matched.length && r.isDefault && !best.isDefault)) {
      best = { ...r, matched };
    }
  }
  return best;
}
