import { HttpError } from "./clickup";
import { getJob } from "./jobs";
import type { Env } from "./types";

/**
 * Cover letters as PDFs, made on the hub so every agent (and the runner, which has no office suite) can
 * attach one wherever a form offers an upload. The text is the agent's, written from the playbook; the hub
 * only typesets it. Files live next to the resumes in R2 under cover-letters/ and are fetched with the
 * agent's own bearer token.
 */

const PAGE_W = 612, PAGE_H = 792, MARGIN = 72, FONT_PT = 11, LEADING = 15;
const CHARS_PER_LINE = 88; // Helvetica 11pt across a 468pt column, with headroom

/** WinAnsi can't take most Unicode; map the common typographic characters and drop the rest. */
const ascii = (s: string) =>
  s
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[•◦⁃]/g, "-")
    .replace(/ /g, " ")
    .replace(/[^\x20-\x7E\n]/g, "");

const pdfEscape = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

function wrap(text: string): string[] {
  const out: string[] = [];
  for (const para of ascii(text).replace(/\r/g, "").split("\n")) {
    if (!para.trim()) { out.push(""); continue; }
    let line = "";
    for (const word of para.split(/\s+/)) {
      if (line && (line + " " + word).length > CHARS_PER_LINE) { out.push(line); line = word; }
      else line = line ? line + " " + word : word;
    }
    out.push(line);
  }
  return out;
}

/** A plain, single-font PDF (Helvetica, US Letter). Enough for a letter; no dependencies. */
export function textToPdf(text: string): Uint8Array {
  const lines = wrap(text);
  const perPage = Math.floor((PAGE_H - 2 * MARGIN) / LEADING);
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  if (!pages.length) pages.push([""]);

  const objects: string[] = []; // 1-based object bodies, index 0 unused
  const add = (body: string) => { objects.push(body); return objects.length; };
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const pagesId = objects.length + 1 + pages.length * 2; // reserved after the page+content pairs
  const pageIds: number[] = [];
  for (const pageLines of pages) {
    const ops = [`BT /F1 ${FONT_PT} Tf ${LEADING} TL ${MARGIN} ${PAGE_H - MARGIN} Td`];
    for (const l of pageLines) ops.push(`(${pdfEscape(l)}) Tj T*`);
    ops.push("ET");
    const stream = ops.join("\n");
    const contentId = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`));
  }
  const realPagesId = add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
  if (realPagesId !== pagesId) throw new Error("pdf object numbering drifted");
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const bucket = (env: Env) => { if (!env.RESUMES) throw new HttpError(503, "RESUMES bucket binding is missing"); return env.RESUMES; };
const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "Company";

export interface CoverLetter { filename: string; key: string; downloadUrl: string; pages: number; chars: number }

/** Typeset a cover letter for a claimed job and store it; the agent downloads it with its token and uploads it to the form. */
export async function makeCoverLetter(env: Env, agent: string, origin: string, a: { id?: string; text?: string }): Promise<CoverLetter> {
  if (!a.id) throw new HttpError(400, "id (the job) is required");
  const text = (a.text ?? "").replace(/\r/g, "").trim();
  if (text.length < 300) throw new HttpError(400, "text is too short for a cover letter (3-4 short paragraphs, at least 300 characters)");
  if (text.length > 4500) throw new HttpError(400, "text is too long (max 4500 characters; one page reads best)");
  if (/linkedin\.com|linkedtfin/i.test(text)) throw new HttpError(400, "do not put a LinkedIn URL in the letter (the profile is suspended); use https://portfolio.prestonzen.com");
  const job = await getJob(env, a.id);
  if (job.claimedBy && job.claimedBy !== agent) throw new HttpError(409, `${job.name} is held by ${job.claimedBy}`);
  const pdf = textToPdf(text);
  const pages = (pdf.length && (new TextDecoder().decode(pdf).match(/\/Type \/Page\b/g) ?? []).length) || 1;
  const date = new Date().toISOString().slice(0, 10);
  const filename = `Preston_Zen_Cover_Letter_${slug(job.company)}_${date}.pdf`;
  const key = `cover-letters/${job.id}-${Date.now()}.pdf`;
  await bucket(env).put(key, pdf, { httpMetadata: { contentType: "application/pdf" }, customMetadata: { filename, job: job.id, agent } });
  return { filename, key, downloadUrl: `${origin}/api/agent/cover-letters/${encodeURIComponent(key.slice("cover-letters/".length))}`, pages, chars: text.length };
}

export async function coverLetterFile(env: Env, name: string): Promise<Response> {
  if (!/^[A-Za-z0-9._-]+\.pdf$/.test(name)) throw new HttpError(400, "bad cover letter name");
  const obj = await bucket(env).get(`cover-letters/${name}`);
  if (!obj) throw new HttpError(404, "no such cover letter");
  const filename = obj.customMetadata?.filename ?? name;
  return new Response(obj.body, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "private, no-store" } });
}
