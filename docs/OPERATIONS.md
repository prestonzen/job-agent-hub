# Job Hunter work routing

## Twice-daily sourcing and backups

The production sourcing check runs at **08:00 and 20:00 Asia/Tokyo**. It is a `sourcing` schedule with no fixed agent. Keep this as one schedule; do not create separate copies for each provider.

Each scheduled occurrence is stored in `source_checks` before its clock advances. Runner heartbeats revisit pending checks, so an offline provider or an outage does not silently consume the occurrence. The selected agent must have an online runner with free capacity, usable credentials/model, its agent switch on, and Sourcing enabled. Claude remains excluded while its switch is off.

If the selected run fails, hits quota, is cancelled, cannot start within two minutes, loses its runner, or finishes without recording new roles, the check tries another eligible agent. Agents already tried in that occurrence are excluded. A check with no eligible provider stays pending. After the available backups are exhausted, the check says `exhausted`; it does not claim that the queue was replenished. The next scheduled occurrence can try again.

There is one active task per agent for automatic dispatch, a fleet concurrency limit, and a database lease plus unique schedule/occurrence key to prevent duplicate dispatch. Backups use the same tracker deduplication rules. Reconnecting runners cannot continue an old cancelled run: its log poll returns cancellation.

An empty job queue can legitimately leave Ollama idle between checks. The admin shows the reason rather than claiming it is working. Parked applications retain their blockers and are not released automatically to manufacture work.

## Per-agent task controls

The Command center has independent switches for Applications (web forms), Email (email applications), Sourcing, and Cyber. Turning off Applications and Email prevents that agent from claiming application work. Email sending separately enforces Email. Source checks enforce Sourcing; cyber dispatch enforces Cyber. These controls select work types, not authorization to scan new cyber targets.

An agent switch disables all new work for that agent. Queued tasks that conflict with changed switches are cancelled; tasks already running finish. Schedules honor both agent and master switches. The daily digest remains independent. A sourcing schedule may use another enabled agent when its preferred agent is off.

## Access versus readiness

- **Signed in**: the runner found the configured credential files/keys. This is access information, not proof that quota remains or that work is available. Invalid credentials surface as a failed run and can trigger fallback.
- **Local model**: Ollama requires no provider sign-in. Its probe also checks the server and configured model.
- **Online**: a runner heartbeat is current.
- **Ready**: enabled, usable on an online runner, not busy/resting/paused, with eligible application work and free capacity.
- **Idle**: access is available but there is no eligible task queued. Sourcing eligibility is shown separately by its task switch.
- **Working**: an actual run is running. A recent heartbeat alone does not mean working.
- **Waiting / unavailable / off**: the admin shows quota/pacing/capacity, missing access/model, or switch state separately.

## Outcomes, not process banners

Run rows and notifications use recorded hub events: applications reported submitted, emails accepted by the mailer, new roles added, review blockers, failed attempts, skips, and cyber reports. An exit code of zero means **process finished**, not an application succeeded. If no work result was recorded, that is the displayed result.

Events are attributed only when exactly one active run owns that agent. Existing reports are matched by agent and event time only when exactly one run window matches; overlapping or outside-run reports remain unassigned. Concurrent manual runs get no inferred credit. Runs show both partial results and claimed jobs that have no final report. The app does not infer success from process-log prose or from a resume upload.

Diagnostics such as visiting Example Domain are labelled diagnostics, hidden from the normal run list by default, excluded from work process metrics, and available through Show diagnostics. Technical logs are collapsed behind the result summary.

## Deployment and regression checks

Run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build`. CI runs the same checks. `tests/dispatch.test.ts` uses real SQLite and covers durable occurrences, concurrent dispatch, disabled/offline/busy/quota providers, backup after zero-result sourcing, task switches, credential/readiness differences, event attribution, and diagnostic outcomes.

Apply the additive `0003_work_routing.sql` and outcome-correlation `0004_recorded_outcomes.sql` migrations before deploying. Existing runners remain compatible. Runner updates wait until the current work finishes; inspect `job-agent-updater` and the runner version rather than interrupting applications to deploy.

If work stops: inspect the queue's available/parked counts, per-agent access and work status, task switches, latest sourcing-check detail, recorded run result, then the technical log. Do not restart a healthy Ollama service just because the queue has no available work.
