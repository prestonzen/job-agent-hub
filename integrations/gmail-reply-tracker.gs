/**
 * Job Agent Hub: Gmail reply tracker (Google Apps Script).
 *
 * Every minute (re-run `install` after changing), sends new mail addressed to the application inbox to the hub, which classifies it
 * (rejection / interview / assessment / offer / ...), updates the ClickUp task and alerts Telegram.
 * Runs inside your own Google account: no OAuth app, no passwords leave Google.
 *
 * Setup (once):
 *   1. https://script.google.com → New project → paste this file.
 *   2. Project Settings → Script properties → add:
 *        HUB_URL        https://jobhunter.prestonzen.com
 *        INBOUND_TOKEN  (the value from .inbound-token.local.txt)
 *        INBOX_ADDRESS  contact@prestonzen.com, prestonzen@kaizenapps.com   (comma-separated: every address recruiters may reply to)
 *   3. Run `install` once and approve the permissions (read Gmail, connect to external service).
 */

const LABEL = "Job Agent Hub/processed";
const MAX_PER_RUN = 40;

function install() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("syncReplies").timeBased().everyMinutes(1).create(); // 1 min (Apps Script allows 1, 5, 10, 15, 30): emailed verification codes are relayed to waiting agents from this feed
  syncReplies();
}

function syncReplies() {
  const props = PropertiesService.getScriptProperties();
  const hub = props.getProperty("HUB_URL");
  const token = props.getProperty("INBOUND_TOKEN");
  const inboxes = (props.getProperty("INBOX_ADDRESS") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!hub || !token || !inboxes.length) throw new Error("Set HUB_URL, INBOUND_TOKEN and INBOX_ADDRESS in Script properties");
  const inbox = inboxes[0];
  // Mail to any of the applicant addresses (an interview invite sent to the older address must not be missed).
  const toAny = inboxes.length > 1 ? `{${inboxes.map((a) => `to:${a}`).join(" ")}}` : `to:${inbox}`;
  const notFromUs = inboxes.map((a) => `-from:${a}`).join(" ");

  const label = GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
  // Mail to the application inbox from others, last 3 days, not yet processed.
  // Labels belong to threads, so excluding processed threads hides new replies.
  // Rotate recent pages and let the hub deduplicate individual message IDs.
  const offset=Number(props.getProperty("REPLY_PAGE_OFFSET")||0);
  const threads = GmailApp.search(`${toAny} ${notFromUs} newer_than:7d`, offset, MAX_PER_RUN);
  props.setProperty("REPLY_PAGE_OFFSET",String(threads.length===MAX_PER_RUN?offset+MAX_PER_RUN:0));

  threads.forEach((thread) => {
    let ok = true;
    thread.getMessages().forEach((m) => {
      if (inboxes.some((a) => m.getFrom().indexOf(a) !== -1)) return; // our own replies
      const res = UrlFetchApp.fetch(`${hub}/api/inbound/email`, {
        method: "post",
        contentType: "application/json",
        headers: { Authorization: `Bearer ${token}` },
        muteHttpExceptions: true,
        payload: JSON.stringify({
          id: m.getId(), // the hub de-duplicates by message id
          from: m.getFrom(),
          subject: m.getSubject(),
          date: m.getDate().toISOString(),
          text: m.getPlainBody().slice(0, 8000),
        }),
      });
      if (res.getResponseCode() >= 300) {
        ok = false;
        console.warn(`hub ${res.getResponseCode()}: ${res.getContentText().slice(0, 200)}`);
      }
    });
    if (ok) thread.addLabel(label);
  });
}
