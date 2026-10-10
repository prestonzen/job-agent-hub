/** Why a parked job is parked, as a short stable category (analytics, and routing essays to the fallback agent). */
export function parkedCategory(reason: string): string {
  const r = reason.toLowerCase();
  if (/already worked/.test(r)) return "Already worked (status not updated)";
  if (/essay|cover letter|written|statement|short answer|free.?text|open.?ended|question/.test(r)) return "Essay or written answers";
  if (/(verification|security|emailed|email|sms|one.?time|login|sign.?in).{0,14}code|\bcode\b|\botp\b|2fa/.test(r)) return "Emailed / SMS code";
  if (/captcha|bot|cloudflare|turnstile|human check|recaptcha|blocked/.test(r)) return "CAPTCHA / bot check";
  if (/account|sign.?up|log.?in|register|password/.test(r)) return "Needs an account";
  if (/location|travel|relocat|onsite|on-site|hybrid|visa|citizen|clearance/.test(r)) return "Location, travel or eligibility";
  if (/duplicate|dupe|already applied/.test(r)) return "Duplicate";
  return "Other";
}
