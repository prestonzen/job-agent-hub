// HackerOne report submission for cyber_work drafts that cleared multi-model review.
// Deliberately narrow: HackerOne only, unanimous draft passes only, one shot per
// evidence row. Anything unclear falls back to the human-review notification.
import { getSetting, setSetting } from './db';
import { notifyBounty, esc } from './telegram';
import type { Env } from './types';

const H1 = 'https://api.hackerone.com/v1';

function authHeader(id: string, token: string): string {
  return 'Basic ' + btoa(`${id}:${token}`);
}

/** Resolve a program display name to its HackerOne team handle, cached in settings. */
async function resolveHandle(env: Env, id: string, token: string, program: string): Promise<string | null> {
  const want = program.trim().toLowerCase();
  const cached = await getSetting<Record<string, string>>(env, 'h1_program_handles');
  if (cached?.[want]) return cached[want];
  // Refresh the cache: page the hacker-visible program list, map lowercase name -> handle.
  const map: Record<string, string> = { ...(cached ?? {}) };
  for (let page = 1; page <= 15; page++) {
    const res = await fetch(`${H1}/hackers/programs?page%5Bsize%5D=100&page%5Bnumber%5D=${page}`, {
      headers: { Authorization: authHeader(id, token), Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { attributes?: { name?: string; handle?: string } }[]; links?: { next?: string } };
    for (const p of body.data ?? []) {
      const name = p.attributes?.name?.trim().toLowerCase();
      const handle = p.attributes?.handle?.trim();
      if (name && handle) map[name] = handle;
    }
    if (map[want] || !body.links?.next) break;
  }
  await setSetting(env, 'h1_program_handles', map).catch(() => {});
  return map[want] ?? null;
}

function draftTitle(result: string, program: string, id: number): string {
  const heading = result.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim();
  const t = heading && heading.length >= 12 && !/report|summary/i.test(heading) ? heading : `Security issue in ${program} (evidence #${id})`;
  return t.slice(0, 200);
}

function draftSection(result: string, name: RegExp): string {
  const m = result.match(new RegExp(`^#{1,4}[^\\n]*(?:${name.source})[^\\n]*\\n([\\s\\S]*?)(?=^#{1,4}\\s|\\s*$)`, 'im'));
  return m?.[1]?.trim().slice(0, 4000) ?? '';
}

function draftSeverity(result: string): string | null {
  const m = result.match(/severity\s*[:\-–]?\s*(critical|high|medium|low|none)\b/i);
  return m ? m[1].toLowerCase() : null;
}

interface SubmitWork { id: number; program: string; platform: string; result: string; unanimousDraft: boolean }
export type SubmitOutcome = { submitted: true; url: string } | { submitted: false };

/**
 * Auto-submit one reviewed draft to HackerOne. { submitted: true } means the caller
 * should persist review='submitted' and announce it; false falls back to human review.
 */
export async function maybeAutoSubmitH1(env: Env, w: SubmitWork): Promise<SubmitOutcome> {
  try {
    if (!(await getSetting<boolean>(env, 'bounty_autosubmit'))) return { submitted: false };
    if (w.platform.trim().toLowerCase() !== 'hackerone') return { submitted: false };
    if (!w.unanimousDraft) return { submitted: false };
    const apiId = await getSetting<string>(env, 'h1_api_id');
    const apiToken = await getSetting<string>(env, 'h1_api_token');
    if (!apiId || !apiToken) return { submitted: false };
    const handle = await resolveHandle(env, apiId, apiToken, w.program);
    if (!handle) {
      await notifyBounty(env, `⚠️ <b>Auto-submit skipped</b> — no HackerOne program handle matches "${esc(w.program)}" (evidence #${w.id}). Leaving it for human review.`);
      return { submitted: false };
    }
    const attributes: Record<string, unknown> = {
      team_handle: handle,
      title: draftTitle(w.result, w.program, w.id),
      vulnerability_information: w.result.slice(0, 24000),
    };
    const impact = draftSection(w.result, /impact/i);
    if (impact) attributes.impact = impact;
    const severity = draftSeverity(w.result);
    if (severity) attributes.severity_rating = severity;
    const res = await fetch(`${H1}/reports`, {
      method: 'POST',
      headers: { Authorization: authHeader(apiId, apiToken), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ data: { type: 'report', attributes } }),
    });
    if (!res.ok) {
      const err = (await res.text()).slice(0, 300);
      await notifyBounty(env, `⚠️ <b>HackerOne auto-submit failed</b> for ${esc(w.program)} · evidence #${w.id} (HTTP ${res.status}). Draft stays in the review queue.\n${esc(err)}`);
      return { submitted: false };
    }
    const body = (await res.json()) as { data?: { id?: string } };
    const url = body.data?.id ? `https://hackerone.com/reports/${body.data.id}` : 'https://hackerone.com/reports';
    return { submitted: true, url };
  } catch (e) {
    console.error('h1 auto-submit:', e);
    return { submitted: false };
  }
}
