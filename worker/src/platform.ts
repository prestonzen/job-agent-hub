import type { Task } from "./types";

/**
 * Where an application was actually submitted. Never "Other": the ClickUp field has no such
 * option, and an unknown site is more useful named (its host) or filed as "Company site".
 * Order: the task's Platform Applied → the "ATS:" line → the apply link's host → "Company site".
 */

const HOSTS: [RegExp, string][] = [
  [/(^|\.)greenhouse\.io$/, "Greenhouse"],
  [/(^|\.)ashbyhq\.com$/, "Ashby"],
  [/(^|\.)lever\.co$/, "Lever"],
  [/(^|\.)workable\.com$/, "Workable"],
  [/(^|\.)breezy\.hr$/, "Breezy"],
  [/(^|\.)(myworkdayjobs|workday)\.com$/, "Workday"],
  [/(^|\.)smartrecruiters\.com$/, "SmartRecruiters"],
  [/(^|\.)rippling\.com$/, "Rippling"],
  [/(^|\.)avature\.net$/, "Avature"],
  [/(^|\.)icims\.com$/, "iCIMS"],
  [/(^|\.)jobvite\.com$/, "Jobvite"],
  [/(^|\.)(applytojob\.com|jazz\.co|jazzhr\.com)$/, "JazzHR"],
  [/(^|\.)bamboohr\.com$/, "BambooHR"],
  [/(^|\.)recruitee\.com$/, "Recruitee"],
  [/(^|\.)teamtailor\.com$/, "Teamtailor"],
  [/(^|\.)personio\.(de|com)$/, "Personio"],
  [/(^|\.)(workatastartup\.com|ycombinator\.com)$/, "Work at a Startup"],
  [/(^|\.)indeed\.com$/, "Indeed Easy Apply"],
  [/(^|\.)linkedin\.com$/, "LinkedIn"],
  [/(^|\.)wellfound\.com$/, "Wellfound"],
  [/(^|\.)upwork\.com$/, "Upwork"],
];

const NAMES: Record<string, string> = {
  greenhouse: "Greenhouse", ashby: "Ashby", lever: "Lever", workable: "Workable", breezy: "Breezy", workday: "Workday",
  smartrecruiters: "SmartRecruiters", rippling: "Rippling", avature: "Avature", icims: "iCIMS", jobvite: "Jobvite",
  jazzhr: "JazzHR", jazz: "JazzHR", bamboohr: "BambooHR", recruitee: "Recruitee", teamtailor: "Teamtailor", personio: "Personio",
  "work at a startup": "Work at a Startup", workatastartup: "Work at a Startup", yc: "Work at a Startup",
  "indeed easy apply": "Indeed Easy Apply", indeed: "Indeed Easy Apply", linkedin: "LinkedIn", wellfound: "Wellfound", upwork: "Upwork",
  "company site": "Company site", "email to employer": "Email to employer", email: "Email to employer",
};

/** Canonical display name for a platform string, or null for empty / "Other" / unknown ("Greenhouse (job-boards)" → "Greenhouse"). */
export function canonicalPlatform(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim().toLowerCase();
  if (!t || t === "other" || t === "unknown" || t === "?") return null;
  if (NAMES[t]) return NAMES[t];
  const first = t.split(/[\s(/,]/)[0];
  return NAMES[first] ?? NAMES[t.replace(/[^a-z ]/g, "").trim()] ?? null;
}

export function platformFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (/^mailto:/i.test(url)) return "Email to employer";
  try {
    const host = new URL(url).hostname.toLowerCase();
    return HOSTS.find(([re]) => re.test(host))?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Best platform for a posting/application: an explicit value, else the apply link, else "Company site". */
export function inferPlatform(opts: { platform?: string | null; ats?: string | null; url?: string | null; text?: string | null }): string {
  const named = canonicalPlatform(opts.platform) ?? canonicalPlatform(opts.ats);
  if (named) return named;
  const fromUrl = platformFromUrl(opts.url);
  if (fromUrl) return fromUrl;
  // Free text in notes ("…on LawPro.ai's JazzHR page…"): look for a known ATS name.
  const text = (opts.text ?? "").toLowerCase();
  for (const key of ["jazzhr", "greenhouse", "ashby", "lever", "workable", "rippling", "smartrecruiters", "workday", "breezy", "icims", "bamboohr"]) {
    if (new RegExp(`\\b${key}\\b`).test(text)) return NAMES[key];
  }
  return "Company site";
}

/** Platform for a ClickUp task (uses its Platform Applied field, then its description). */
export function taskPlatform(t: Task): string {
  const url = t.description.match(/https?:\/\/[^\s\])]+/)?.[0] ?? null;
  const ats = t.description.match(/ATS:\s*([^|\n]+)/i)?.[1] ?? null;
  return inferPlatform({ platform: t.platform, ats, url, text: t.description });
}
