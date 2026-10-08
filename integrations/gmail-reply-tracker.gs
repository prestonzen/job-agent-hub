/**
 * Job Agent Hub: Gmail reply tracker (Google Apps Script).
 *
 * Every 10 minutes, sends new mail addressed to the application inbox to the hub, which classifies it
 * (rejection / interview / assessment / offer / ...), updates the ClickUp task and alerts Telegram.
 * Runs inside your own Google account: no OAuth app, no passwords leave Google.
 *
 * Setup (once):
 *   1. https://script.google.com → New project → paste this file.
 *   2. Project Settings → Script properties → add:
 *        HUB_URL        https://jobhunter.prestonzen.com
 *        INBOUND_TOKEN  (the value from .inbound-token.local.txt)
 *        INBOX_ADDRESS  contact@prestonzen.com
 *   3. Run `install` once and approve the permissions (read Gmail, connect to external service).
 */

const LABEL = "Job Agent Hub/processed";
const MAX_PER_RUN = 40;

function install() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("syncReplies").timeBased().everyMinutes(10).create();
  syncReplies();
}

function syncReplies() {
  const props = PropertiesService.getScriptProperties();
  const hub = props.getProperty("HUB_URL");
  const token = props.getProperty("INBOUND_TOKEN");
  const inbox = props.getProperty("INBOX_ADDRESS");
  if (!hub || !token || !inbox) throw new Error("Set HUB_URL, INBOUND_TOKEN and INBOX_ADDRESS in Script properties");

  const label = GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
  // Mail to the application inbox from others, last 3 days, not yet processed.
  const threads = GmailApp.search(`to:${inbox} -from:${inbox} newer_than:3d -label:"${LABEL}"`, 0, MAX_PER_RUN);

  threads.forEach((thread) => {
    let ok = true;
    thread.getMessages().forEach((m) => {
      if (m.getFrom().indexOf(inbox) !== -1) return; // our own replies
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
