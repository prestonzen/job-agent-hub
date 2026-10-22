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
  // Forms that ask the applicant to attest to being a person: an agent must not answer, so only Preston can submit.
  if (/attestation|automated program|human being|best describes you|are you (a )?human|not a (ro)?bot|i am (a )?human/.test(r)) return "Human attestation (must be a person)";
  // Walls a person has to clear come before content categories, so "filled the essay, then a reCAPTCHA" lands here.
  if (/captcha|bot check|cloudflare|turnstile|human check|recaptcha|blocked|\b403\b/.test(r)) return "CAPTCHA / bot check";
  if (/(verification|security|emailed|email|sms|one.?time|login|sign.?in).{0,14}code|\bcode\b|otp|2fa/.test(r)) return "Emailed / SMS code";
  if (/account|sign.?up|sign.?in|log.?in|register|password|credentials|vault/.test(r)) return "Needs an account";
  if (/loom|video walkthrough|record(ing)? a video|screen recording|work sample|portfolio piece/.test(r)) return "Video or work sample (Preston only)";
  if (/linkedin url|valid linkedin|linkedin profile (is )?required/.test(r)) return "LinkedIn URL required (profile suspended)";
  if (/upload(ed|ing)? (the )?(resume|cv|file)|file upload|could not upload|failed to upload/.test(r)) return "File upload failed";
  if (/only preston|metrics|measured results|baselines|facts (only|that) preston|verified facts/.test(r)) return "Needs facts only Preston has";
  if (/form cleanup|manual finish|filled completely|fully filled|ready to submit|only submit/.test(r)) return "Ready to submit (click Submit)";
  if (/essay|cover letter|written|statement|short answer|free.?text|open.?ended|question|case study|mission/.test(r)) return "Essay or written answers";
  if (/location|travel|relocat|onsite|on-site|hybrid|visa|citizen|clearance/.test(r)) return "Location, travel or eligibility";
  if (/duplicate|dupe|already applied/.test(r)) return "Duplicate";
  if (/^parked$|marked in the task name|^needs a person$/.test(r)) return "Parked without a reason";
  return "Uncategorized";
}
