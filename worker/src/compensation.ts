/** Preston, 2026-11-06. Cash amounts/currencies and other eligibility rules are unchanged. */
export const COMPENSATION_RULE = "CASH COMPENSATION REQUIRED (2026-11-06): salary or contractor cash pay must start with work. Equity may be additional, never the sole initial compensation. Exclude equity-only, unpaid/sweat-equity and cash deferred until funding, revenue, profitability or other milestones from sourcing, applications and interviews. Salary plus equity is allowed. Undisclosed salary is unknown, not unpaid: research it without inventing pay. Before recommending, arranging or progressing an interview, confirm cash pay starts with work and record 'Cash compensation confirmed: <source/date and terms>; starts with work'. Broad pay-not-a-reason-to-skip language does not override this rule; existing flexibility on cash amounts/currencies remains. Preserve history and record a dated user-policy exclusion, not an employer rejection.";

/** Conservative explicit evidence only. Generic equity mentions and missing salary are not exclusions. */
export function compensationExclusion(...parts: (string | null | undefined)[]): string | null {
  const text = parts.filter(Boolean).join("\n").replace(/[\u2010-\u2015]/g, "-");
  for (const clause of text.split(/[\n;!?]|\.(?!\d)/)) {
    // Avoid reading a denial of equity-only terms as an offer of those terms.
    const clean = clause.replace(/\b(?:not|never|isn't|is not)\s+(?:an?\s+)?(?:equity[- ]only|equity[- ]first|unpaid|sweat[- ]equity)\b/gi, "");
    const explicit = clean.match(/\b(?:equity[- ]only|(?:only|solely)\s+(?:in\s+)?equity|sweat[- ]equity|unpaid\s+(?:role|position|work|initially)|(?:no|zero)\s+(?:cash\s+)?(?:salary|pay|compensation)(?!\s+(?:cap|limit|ceiling|range|details?|listed|disclosed|posted|specified|stated|information)\b)|(?:salary|cash\s+pay)\s*[:=]\s*(?:\$|USD\s*)?0(?![.\d]))\b/i);
    const deferred = clean.match(/\b(?:salary|cash(?:\s+(?:pay|compensation))?|pay)\b[^\n;.!?]{0,60}\b(?:after|until|once|upon|post[- ]|deferred|contingent)\b[^\n;.!?]{0,60}\b(?:funding|funded|fundrais\w*|revenue|profit\w*|seed|milestone\w*|investment)\b/i)
      ?? clean.match(/\bequity\b[^\n;.!?]{0,40}\buntil\b[^\n;.!?]{0,40}\b(?:funding|funded|revenue|profit\w*|seed|milestone\w*)\b/i);
    if (explicit || deferred) return `Excluded by user compensation policy (2026-11-06): ${String(explicit?.[0] ?? deferred?.[0]).trim()}; cash pay must start with work.`;
  }
  return null;
}

/** Confirmation is evidence recorded by an agent, not an inference from missing salary or future promises. */
export function cashCompensationConfirmed(text: string): boolean {
  return !compensationExclusion(text) && /cash compensation confirmed:[^\n]+\bstarts? with work\b/i.test(text);
}

export function interviewCompensationHold(text: string): string | null {
  return compensationExclusion(text) ?? (cashCompensationConfirmed(text) ? null : "Confirm salary or contractor cash pay starts with work before recommending, arranging or progressing an interview; record source, date and terms.");
}
