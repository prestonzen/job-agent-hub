import { getSetting, setSetting } from "./db";
import { addJob } from "./jobs";
import { inferPlatform } from "./platform";
import { esc, notify } from "./telegram";
import type { Env } from "./types";

/**
 * Feed sourcing: the remote-job boards with public JSON/RSS feeds, pulled straight into the queue with no
 * LLM in the loop. Cheap, so it runs twice a day from the autopilot tick (and on demand from the admin).
 * Each posting is filtered by title, by US/worldwide eligibility and by the platform behind the apply link
 * (never Ashby, Work At A Startup, Wellfound or LinkedIn — those never convert for agents), then handed to
 * addJob, which de-duplicates against ClickUp.
 */

export const FEED_AGENT = "feeds";
const EVERY_MS = 12 * 3_600_000;
const MAX_ADDS = 12;
const UA = "JobAgentHub/1.0 (+https://jobhunter.prestonzen.com)";

interface Lead { company: string; role: string; url: string; location: string; text: string; pay?: string; source: string }

const TITLE_OK = /\b(ai|a\.i\.|ml|machine learning|llm|genai|generative|agents?|agentic|full[- ]?stack|software engineer|backend|back-end|platform engineer|founding engineer|security engineer|ai security|applied scientist|forward deployed)\b/i;
const TITLE_NO = /\b(intern|internship|junior|jr\.?|director|vp|vice president|head of|chief|principal|manager|recruiter|sales|marketing|designer|data entry|support engineer|account executive|contractor-?only)\b/i;
const STAFF = /\bstaff\b/i;
const LOC_OK = /\b(united states|usa|u\.s\.|us only|us-only|north america|americas|worldwide|anywhere|global|remote)\b/i;
const LOC_NO = /\b(europe|emea|eu only|uk only|united kingdom|germany|france|netherlands|spain|poland|india|latam|apac|australia|canada only|brazil|ukraine|portugal)\b/i;
const URL_NO = /ashbyhq\.com|workatastartup\.com|wellfound\.com|angel\.co|linkedin\.com/i;

function keep(l: Lead): boolean {
  if (!l.company || !l.role || !/^https?:\/\//.test(l.url)) return false;
  if (!TITLE_OK.test(l.role) || TITLE_NO.test(l.role)) return false;
  if (STAFF.test(l.role) && !/security/i.test(l.role)) return false;
  if (URL_NO.test(l.url)) return false;
  const loc = `${l.location} ${l.text.slice(0, 1500)}`;
  if (LOC_NO.test(l.location) && !LOC_OK.test(l.location)) return false;
  if (!LOC_OK.test(loc)) return false;
  return true;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
    return r.ok ? ((await r.json()) as T) : null;
  } catch { return null; }
}
async function getText(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12_000) });
    return r.ok ? await r.text() : null;
  } catch { return null; }
}
const strip = (html: string | undefined | null) => (html ?? "").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
const pay = (lo?: number | string | null, hi?: number | string | null) => (lo || hi ? `$${lo ?? "?"}–$${hi ?? "?"}` : undefined);

const SOURCES: Record<string, () => Promise<Lead[]>> = {
  remoteok: async () => {
    type R = { position?: string; company?: string; location?: string; url?: string; apply_url?: string; description?: string; salary_min?: number; salary_max?: number };
    const rows = (await getJson<R[]>("https://remoteok.com/api")) ?? [];
    return rows.filter((r) => r.position).map((r) => ({ company: r.company ?? "", role: r.position ?? "", url: r.apply_url || r.url || "", location: r.location ?? "", text: strip(r.description), pay: pay(r.salary_min, r.salary_max), source: "RemoteOK" }));
  },
  remotive: async () => {
    type R = { jobs?: { url: string; title: string; company_name: string; candidate_required_location?: string; description?: string; salary?: string }[] };
    const j = await getJson<R>("https://remotive.com/api/remote-jobs?category=software-dev&limit=150");
    return (j?.jobs ?? []).map((r) => ({ company: r.company_name, role: r.title, url: r.url, location: r.candidate_required_location ?? "", text: strip(r.description), pay: r.salary || undefined, source: "Remotive" }));
  },
  himalayas: async () => {
    type R = { jobs?: { title: string; companyName: string; applicationLink?: string; locationRestrictions?: string[]; description?: string; minSalary?: number; maxSalary?: number }[] };
    const j = await getJson<R>("https://himalayas.app/jobs/api?limit=100");
    return (j?.jobs ?? []).map((r) => ({ company: r.companyName, role: r.title, url: r.applicationLink ?? "", location: (r.locationRestrictions ?? []).join(", ") || "worldwide", text: strip(r.description), pay: pay(r.minSalary, r.maxSalary), source: "Himalayas" }));
  },
  jobicy: async () => {
    type R = { jobs?: { jobTitle: string; companyName: string; url: string; jobGeo?: string; jobDescription?: string; annualSalaryMin?: number; annualSalaryMax?: number }[] };
    const out: Lead[] = [];
    for (const tag of ["ai", "machine-learning", "backend"]) {
      const j = await getJson<R>(`https://jobicy.com/api/v2/remote-jobs?count=50&tag=${tag}`);
      for (const r of j?.jobs ?? []) out.push({ company: r.companyName, role: r.jobTitle, url: r.url, location: r.jobGeo ?? "", text: strip(r.jobDescription), pay: pay(r.annualSalaryMin, r.annualSalaryMax), source: "Jobicy" });
    }
    return out;
  },
  weworkremotely: async () => {
    const xml = (await getText("https://weworkremotely.com/categories/remote-programming-jobs.rss")) ?? "";
    const out: Lead[] = [];
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const it = m[1];
      const title = strip(it.match(/<title>([\s\S]*?)<\/title>/)?.[1]);
      const link = it.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ?? "";
      const region = strip(it.match(/<region>([\s\S]*?)<\/region>/)?.[1]);
      const [company, ...rest] = title.split(":");
      out.push({ company: company.trim(), role: rest.join(":").trim(), url: link, location: region, text: strip(it.match(/<description>([\s\S]*?)<\/description>/)?.[1]).slice(0, 2000), source: "We Work Remotely" });
    }
    return out;
  },
};

/** Pull every feed, filter, add new postings. Gated to twice a day unless forced. */
export async function runFeeds(env: Env, force = false): Promise<{ ran: boolean; added: string[]; seen: number; kept: number; errors: string[] }> {
  const now = Date.now();
  const last = (await getSetting<{ at: number }>(env, "feeds_last_run"))?.at ?? 0;
  if (!force && now - last < EVERY_MS) return { ran: false, added: [], seen: 0, kept: 0, errors: [] };
  await setSetting(env, "feeds_last_run", { at: now });
  const seenUrls = new Set((await getSetting<string[]>(env, "feeds_seen")) ?? []);
  const added: string[] = []; const errors: string[] = []; let seen = 0; let kept = 0;
  for (const [name, fn] of Object.entries(SOURCES)) {
    let leads: Lead[] = [];
    try { leads = await fn(); } catch (e) { errors.push(`${name}: ${(e as Error).message}`); continue; }
    seen += leads.length;
    for (const l of leads) {
      if (added.length >= MAX_ADDS) break;
      if (seenUrls.has(l.url)) continue;
      seenUrls.add(l.url);
      if (!keep(l)) continue;
      kept++;
      const ats = inferPlatform({ url: l.url });
      try {
        const r = await addJob(env, FEED_AGENT, {
          company: l.company.slice(0, 80), role: l.role.slice(0, 120), url: l.url, ats, pay: l.pay ?? "Not disclosed",
          travel: "Not specified", fit: "unrated", notes: `Source: ${l.source} feed | Location: ${l.location || "remote"} | Checked: ${new Date().toISOString().slice(0, 10)} | ${l.text.slice(0, 600)}`,
        });
        if (r.created) added.push(`${l.company} — ${l.role}`);
      } catch (e) { errors.push(`${l.company}: ${(e as Error).message.slice(0, 80)}`); }
    }
  }
  await setSetting(env, "feeds_seen", [...seenUrls].slice(-4000));
  if (added.length) await notify(env, `📡 <b>Feeds added ${added.length} role${added.length === 1 ? "" : "s"}</b> (${seen} seen, ${kept} passed the filters)\n${added.slice(0, 12).map((a) => `• ${esc(a)}`).join("\n")}`, { silent: true });
  return { ran: true, added, seen, kept, errors };
}
