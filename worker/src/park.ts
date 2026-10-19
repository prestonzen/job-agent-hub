/** Why a parked job is parked, as a short stable category (analytics, and routing essays to the fallback agent). */
export function parkedCategory(reason: string): string {
  const r = reason.toLowerCase();
  if (/already worked/.test(r)) return "Already worked (status not updated)";
  if (/failed 2x|failed twice|see the hub comments/.test(r)) return "Failed twice (see attempt log)";
  // ATS anti-fraud flags before "blocked", so "BLOCKED: spam flag" lands here and not in CAPTCHA.
  if (/spam|fraud|flagged|anti-detection/.test(r)) return "ATS spam / fraud flag";
  if (/limiting applications|within the last \d+ days|90 days|reapply|applied for a position/.test(r)) return "Company limit (recent application)";
  // The agent found the employer's address but the job record had no applyEmail: a data fix, not a human task.
  if (/applyemail|apply email|emailing|email application|manual email|interest email/.test(r)) return "Email address not on record";
  if (/essay|cover letter|written|statement|short answer|free.?text|open.?ended|question|case study|mission/.test(r)) return "Essay or written answers";
  if (/(verification|security|emailed|email|sms|one.?time|login|sign.?in).{0,14}code|code|otp|2fa/.test(r)) return "Emailed / SMS code";
  if (/captcha|bot|cloudflare|turnstile|human check|recaptcha|blocked|403/.test(r)) return "CAPTCHA / bot check";
  if (/account|sign.?up|sign.?in|log.?in|register|password|credentials|vault/.test(r)) return "Needs an account";
  if (/location|travel|relocat|onsite|on-site|hybrid|visa|citizen|clearance/.test(r)) return "Location, travel or eligibility";
  if (/duplicate|dupe|already applied/.test(r)) return "Duplicate";
  if (/^parked$|marked in the task name|^needs a person$|form cleanup/.test(r)) return "Parked without a reason";
  return "Uncategorized";
}
