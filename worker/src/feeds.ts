import { getSetting, setSetting } from "./db";
import { addJob, loadTasks } from "./jobs";
import { inferPlatform } from "./platform";
import { esc, notify } from "./telegram";
import type { Env } from "./types";

/**
 * Feed sourcing with no LLM in the loop: public job boards with JSON/RSS feeds, the monthly Hacker News
 * "Who is hiring?" thread, Built In, and the Greenhouse / Lever / Workable boards of companies already in the
 * tracker. Postings are filtered by title, by US/worldwide eligibility, by company size (blocklist of household
 * names) and by the platform behind the apply link (never Ashby, Wellfound or LinkedIn; Work At A Startup
 * is allowed again since 2026-10-22 — Preston's account session is synced into every agent profile),
 * then handed to addJob, which de-duplicates against ClickUp.
 *
 * Runs from the autopilot tick in three rotating phases (one per 4 h, so each source is polled twice a day)
 * to stay well under the per-request subrequest budget.
 */

export const FEED_AGENT = "feeds";
const EVERY_MS = 4 * 3_600_000;
const MAX_ADDS = 12;
const UA = "JobAgentHub/1.0 (+https://jobhunter.prestonzen.com)";
export const PHASES = ["boards", "hn", "companies"] as const;
export type Phase = (typeof PHASES)[number];

interface Lead { company: string; role: string; url: string; applyUrl?: string; applyEmail?: string; location: string; text: string; pay?: string; source: string }

const TITLE_OK = /\b(ai|a\.i\.|ml|machine learning|llm|genai|generative|agents?|agentic|full[- ]?stack|software engineer|backend|back-end|platform engineer|founding engineer|security engineer|ai security|applied scientist|forward deployed)\b/i;
const TITLE_NO = /\b(intern|internship|junior|jr\.?|director|vp|vice president|head of|chief|principal|manager|recruiter|sales|marketing|designer|data entry|support engineer|account executive|contractor-?only|solutions? architect|web3|solidity|blockchain|crypto|defi|card authorization|payments? engineer|embedded|firmware|mobile|ios|android|game|training lead|trainer|annotat|data labell?ing|evaluator|rater|tutor|apprentice|fuzzing|llvm|csm|customer success)\b/i;
const STAFF = /\bstaff\b/i;
/** A generic engineering title only passes when the posting itself is about AI/LLM/agents. */
const AI_TERMS = /\b(ai|a\.i\.|ml|machine learning|llm|genai|generative|agents?|agentic|rag|embeddings?|openai|anthropic|claude|gpt)\b/i;
const GENERIC = /\b(full[- ]?stack|software engineer|backend|back-end|platform engineer|founding engineer)\b/i;
/** Household names and >1,000-person companies: they don't convert and aren't the target (Preston, 2026-10-20). */
const BIG_CO = /^(nvidia|google|alphabet|meta|facebook|amazon|aws|microsoft|apple|netflix|openai|anthropic|cohere|elevenlabs|eleven labs|stripe|coinbase|gitlab|github|datadog|cloudflare|salesforce|oracle|ibm|intel|adobe|uber|lyft|airbnb|doordash|shopify|atlassian|twilio|snowflake|databricks|palantir|betterhelp|toast|reddit|zscaler|samsara|servicenow|workday|vmware|cisco|dell|hp|sap|paypal|block|square|robinhood|instacart|pinterest|snap|tiktok|bytedance|linkedin|x|twitter|tesla|spacex|grafana labs|mongodb|elastic|hashicorp|okta|crowdstrike|zoominfo|typeform|launchdarkly|hubspot|zendesk|intercom|notion|figma|canva|dropbox|box|slack|zoom|docusign|affirm|chime|sofi|nerdwallet|upstart|brex|ramp|rippling|gusto|deel|remote|mercury|plaid|checkr|verkada|anduril|scale ai|turing|wellfound|spotify|canonical|doximity|glean|tether|customer\.io|postscript|dremio|supabase|g-p|globalization partners|kraken|kraken tech|singlestore|posthog)\b/i;
/**
 * Location (Preston, 2026-10-22, widened the same day): ANY country, ANY company, as long as the work is remote
 * (no physical presence) and the posting is in English. Residency or time-zone requirements are no longer a
 * filter: Preston will relocate and work remotely from the country if a role needs it. Only onsite/hybrid roles
 * and non-English postings are dropped.
 */
const REMOTE = /(remote|work from home|wfh|work from anywhere|anywhere|worldwide|distributed|telecommut|home[- ]based|fully remote|remote[- ]first)/i;
const ONSITE_ONLY = /(on[- ]?site only|onsite only|in[- ]office only|hybrid only|no remote|not remote|must be on[- ]?site|office[- ]based role|relocation required)/i;
const NON_ENGLISH = /(ingenieur|ingénieur|entwickler|desarrollador|sviluppatore|programista|développeur|разработчик|инженер|ontwikkelaar|utvecklare|kehittäjä|yazılım|開発|工程师|エンジニア)/i;
const URL_NO = /ashbyhq\.com|wellfound\.com|angel\.co|linkedin\.com/i;

function keep(l: Lead): boolean {
  const apply = l.applyUrl ?? l.url;
  if (!l.company || !l.role) return false;
  if (!l.applyEmail && !/^https?:\/\//.test(apply)) return false;
  if (!TITLE_OK.test(l.role) || TITLE_NO.test(l.role)) return false;
  if (STAFF.test(l.role) && !/security/i.test(l.role)) return false;
  if (BIG_CO.test(l.company.trim())) return false;
  if (URL_NO.test(apply)) return false;
  if (GENERIC.test(l.role) && !AI_TERMS.test(l.role) && !AI_TERMS.test(l.text.slice(0, 2500))) return false;
  const loc = `${l.location} ${l.text.slice(0, 2500)}`;
  if (NON_ENGLISH.test(`${l.role} ${l.text.slice(0, 400)}`)) return false;
  if (ONSITE_ONLY.test(loc)) return false;
  if (!REMOTE.test(loc)) return false;
  return true;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
    return r.ok ? ((await r.json()) as T) : null;
  } catch { return null; }
}
async function getText(url: string, ua = UA): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": ua }, signal: AbortSignal.timeout(12_000) });
    return r.ok ? await r.text() : null;
  } catch { return null; }
}
const strip = (html: string | undefined | null) => (html ?? "").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
const pay = (lo?: number | string | null, hi?: number | string | null) => (lo || hi ? `$${lo ?? "?"}–$${hi ?? "?"}` : undefined);
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

// ---------- phase "boards": public remote-job boards ----------
const BOARDS: Record<string, () => Promise<Lead[]>> = {
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
    // The Jobicy "Apply" button is login-gated JS; the listing URL is kept and the agent finds the employer's own
    // posting (playbook, Platform Log → Jobicy). Tags under 3 chars are rejected, so filter by geo + industry.
    type R = { jobs?: { jobTitle: string; companyName: string; url: string; jobGeo?: string; jobDescription?: string }[] };
    const out: Lead[] = [];
    for (const q of ["anywhere", "usa", "europe", "uk", "canada", "apac", "latam", "emea"].map((g) => `geo=${g}&industry=engineering`).concat(["geo=anywhere&tag=machine-learning"])) {
      const j = await getJson<R>(`https://jobicy.com/api/v2/remote-jobs?count=50&${q}`);
      for (const r of j?.jobs ?? []) out.push({ company: r.companyName, role: r.jobTitle, url: r.url, location: r.jobGeo ?? "", text: strip(r.jobDescription), source: "Jobicy" });
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
  builtin: async () => {
    // Built In has no API: the remote AI/engineering listing page, then each job page's JSON-LD JobPosting.
    const list = (await getText("https://builtin.com/jobs/remote/dev-engineering/ai?country=USA", BROWSER_UA)) ?? "";
    const links = [...new Set([...list.matchAll(/href="(\/job\/[^"?#]+)"/g)].map((m) => `https://builtin.com${m[1]}`))].slice(0, 8);
    const out: Lead[] = [];
    for (const u of links) {
      const page = (await getText(u, BROWSER_UA)) ?? "";
      for (const m of page.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
        try {
          const j = JSON.parse(m[1]) as { "@type"?: string; title?: string; hiringOrganization?: { name?: string }; jobLocation?: { address?: { addressCountry?: string; addressLocality?: string } } | { address?: { addressCountry?: string } }[]; description?: string; url?: string; directApply?: boolean };
          if (j["@type"] !== "JobPosting") continue;
          const locs = Array.isArray(j.jobLocation) ? j.jobLocation : j.jobLocation ? [j.jobLocation] : [];
          out.push({ company: j.hiringOrganization?.name ?? "", role: j.title ?? "", url: u, location: `remote ${locs.map((l) => l.address?.addressCountry ?? "").join(" ")}`, text: strip(j.description), source: "Built In" });
        } catch { /* not the posting block */ }
      }
    }
    return out;
  },
};

// ---------- phase "hn": Ask HN: Who is hiring? (current + previous month) ----------
const EMAIL_RE = /([a-z0-9._%+-]+)\s*(?:@|\[at\]|\(at\)|\sat\s)\s*([a-z0-9.-]+)\s*(?:\.|\[dot\]|\(dot\)|\sdot\s)\s*([a-z]{2,})/i;
async function hnLeads(): Promise<Lead[]> {
  type Hit = { objectID: string; title: string };
  const s = await getJson<{ hits: Hit[] }>("https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=6");
  const threads = (s?.hits ?? []).filter((h) => /who is hiring/i.test(h.title)).slice(0, 2);
  const out: Lead[] = [];
  for (const t of threads) {
    type Item = { id: number; author: string | null; text: string | null; children?: Item[] };
    const item = await getJson<Item>(`https://hn.algolia.com/api/v1/items/${t.objectID}`);
    for (const c of item?.children ?? []) {
      if (!c.text || !c.author) continue;
      const text = strip(c.text.replace(/<p>/gi, "\n"));
      if (!/\bremote\b/i.test(text)) continue;
      const head = text.split("\n")[0] ?? text.slice(0, 200);
      const parts = head.split("|").map((x) => x.trim()).filter(Boolean);
      if (parts.length < 2) continue;
      const company = parts[0].replace(/\(.*?\)/g, "").replace(/https?:\s*\/?\/?\S+/g, "").replace(/www\.\S+/g, "").trim().slice(0, 80);
      // The role must be a short header segment that names a role; a description-looking segment means the
      // post isn't in the usual "Company | Role | Location" shape, so look for "hiring a <role>" in the body.
      const ROLE = /engineer|developer|scientist|architect|founding|swe\b|programmer/i;
      let role = parts.slice(1).find((p) => p.length <= 80 && ROLE.test(p) && !/https?:\/\//.test(p)) ?? "";
      if (!role) role = text.match(/(?:hiring|looking for|seeking)\s+(?:an?\s+|\d+\s+)?((?:senior|staff|lead|founding|principal|full[- ]?stack|backend|ai|ml|software|platform|applied)[^.,;:\n|]{0,60}?(?:engineers?|developers?|scientists?))/i)?.[1]?.trim() ?? "";
      if (!role) continue;
      role = role.replace(/\s+/g, " ").slice(0, 120);
      if (!company || /^https?:/.test(company)) continue;
      if (/(multiple|various|several|many).*roles?/i.test(role)) continue; // "Multiple Engineering roles": nothing specific to apply for
      const em = text.match(EMAIL_RE);
      const applyEmail = em ? `${em[1]}@${em[2]}.${em[3]}`.toLowerCase() : undefined;
      const urls = [...text.matchAll(/https?:\/\/[^\s)<>"']+/g)].map((m) => m[0].replace(/[.,;:]+$/, "")).filter((u) => !/news\.ycombinator\.com|linkedin\.com|twitter\.com|x\.com/i.test(u));
      const applyUrl = urls.find((u) => /jobs?|careers?|apply|greenhouse|lever|workable|hiring/i.test(u)) ?? urls[0];
      out.push({ company, role, url: `https://news.ycombinator.com/item?id=${c.id}`, applyUrl: applyEmail ? undefined : applyUrl, applyEmail, location: head, text, source: `HN ${t.title.replace(/Ask HN: Who is hiring\? /i, "")}` });
    }
  }
  return out;
}

// ---------- phase "companies": Greenhouse / Lever / Workable boards of companies already tracked ----------
interface Boards { greenhouse: string[]; lever: string[]; workable: string[] }
async function knownBoards(env: Env): Promise<Boards> {
  const saved = (await getSetting<Boards>(env, "feed_boards")) ?? { greenhouse: [], lever: [], workable: [] };
  const b: Boards = { greenhouse: new Set(saved.greenhouse), lever: new Set(saved.lever), workable: new Set(saved.workable) } as unknown as Boards;
  const sets = b as unknown as Record<keyof Boards, Set<string>>;
  for (const t of await loadTasks(env).catch(() => [])) {
    const d = t.description ?? "";
    for (const m of d.matchAll(/(?:job-boards|boards)\.greenhouse\.io\/([a-z0-9_-]+)/gi)) sets.greenhouse.add(m[1].toLowerCase());
    for (const m of d.matchAll(/jobs\.lever\.co\/([a-z0-9_-]+)/gi)) sets.lever.add(m[1].toLowerCase());
    for (const m of d.matchAll(/apply\.workable\.com\/([a-z0-9_-]+)\//gi)) sets.workable.add(m[1].toLowerCase());
  }
  const out: Boards = { greenhouse: [...sets.greenhouse].filter((x) => x !== "embed"), lever: [...sets.lever], workable: [...sets.workable].filter((x) => x !== "api" && x !== "j") };
  await setSetting(env, "feed_boards", out);
  return out;
}
async function companyLeads(env: Env): Promise<Lead[]> {
  const b = await knownBoards(env);
  const out: Lead[] = [];
  let budget = 28; // subrequests for board fetches in one run
  for (const token of b.greenhouse) {
    if (budget-- <= 0) break;
    type G = { jobs?: { title: string; absolute_url: string; location?: { name?: string }; content?: string; company_name?: string }[] };
    const j = await getJson<G>(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`);
    for (const r of j?.jobs ?? []) out.push({ company: r.company_name ?? token, role: r.title, url: r.absolute_url, location: r.location?.name ?? "", text: strip(r.content).slice(0, 3000), source: "Greenhouse board" });
  }
  for (const token of b.lever) {
    if (budget-- <= 0) break;
    type L = { text: string; hostedUrl: string; applyUrl?: string; categories?: { location?: string; team?: string }; descriptionPlain?: string; workplaceType?: string }[];
    const j = await getJson<L>(`https://api.lever.co/v0/postings/${token}?mode=json`);
    for (const r of j ?? []) out.push({ company: token, role: r.text, url: r.hostedUrl, location: `${r.categories?.location ?? ""} ${r.workplaceType ?? ""}`, text: (r.descriptionPlain ?? "").slice(0, 3000), source: "Lever board" });
  }
  for (const token of b.workable) {
    if (budget-- <= 0) break;
    type W = { name?: string; jobs?: { title: string; url: string; country?: string; state?: string; city?: string; telecommuting?: boolean; description?: string }[] };
    const j = await getJson<W>(`https://apply.workable.com/api/v1/widget/accounts/${token}`);
    for (const r of j?.jobs ?? []) out.push({ company: j?.name ?? token, role: r.title, url: r.url, location: `${r.telecommuting ? "remote " : ""}${r.country ?? ""} ${r.state ?? ""}`, text: strip(r.description).slice(0, 3000), source: "Workable board" });
  }
  return out;
}

/** One phase of feed sourcing. Gated to every 4 h unless forced; `phase` overrides the rotation. */
export async function runFeeds(env: Env, force = false, phase?: Phase): Promise<{ ran: boolean; phase: Phase | null; added: string[]; seen: number; kept: number; errors: string[] }> {
  const now = Date.now();
  const state = (await getSetting<{ at: number; next: number }>(env, "feeds_last_run")) ?? { at: 0, next: 0 };
  if (!force && now - state.at < EVERY_MS) return { ran: false, phase: null, added: [], seen: 0, kept: 0, errors: [] };
  const ph: Phase = phase ?? PHASES[state.next % PHASES.length];
  await setSetting(env, "feeds_last_run", { at: now, next: (phase ? state.next : state.next + 1) % PHASES.length });
  const seenUrls = new Set((await getSetting<string[]>(env, "feeds_seen")) ?? []);
  const added: string[] = []; const errors: string[] = []; let seen = 0; let kept = 0;
  const sources: [string, () => Promise<Lead[]>][] =
    ph === "boards" ? Object.entries(BOARDS) : ph === "hn" ? [["hn", hnLeads]] : [["companies", () => companyLeads(env)]];
  for (const [name, fn] of sources) {
    let leads: Lead[] = [];
    try { leads = await fn(); } catch (e) { errors.push(`${name}: ${(e as Error).message}`); continue; }
    seen += leads.length;
    for (const l of leads) {
      if (added.length >= MAX_ADDS) break;
      const key = l.applyEmail ? `${l.company}|${l.role}|${l.applyEmail}`.toLowerCase() : l.applyUrl ?? l.url;
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);
      if (!keep(l)) continue;
      kept++;
      const applyUrl = l.applyUrl ?? l.url;
      try {
        const r = await addJob(env, FEED_AGENT, {
          company: l.company.slice(0, 80), role: l.role.slice(0, 120), url: applyUrl, applyEmail: l.applyEmail,
          ats: l.applyEmail ? "Email" : inferPlatform({ url: applyUrl }), pay: l.pay ?? "Not disclosed", travel: "Not specified", fit: "unrated",
          notes: `Source: ${l.source} | Source post: ${l.url} | Location: ${l.location || "remote"} | Checked: ${new Date().toISOString().slice(0, 10)} | ${l.text.slice(0, 600)}`,
        });
        if (r.created) added.push(`${l.company} — ${l.role}${l.applyEmail ? " (email)" : ""}`);
      } catch (e) { errors.push(`${l.company}: ${(e as Error).message.slice(0, 80)}`); }
    }
  }
  await setSetting(env, "feeds_seen", [...seenUrls].slice(-6000));
  if (added.length) await notify(env, `📡 <b>Feeds (${ph}) added ${added.length} role${added.length === 1 ? "" : "s"}</b> (${seen} seen, ${kept} passed the filters)\n${added.slice(0, 12).map((a) => `• ${esc(a)}`).join("\n")}`, { silent: true });
  return { ran: true, phase: ph, added, seen, kept, errors };
}
