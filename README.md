# LinkedIn Unread Reporter

A local Playwright utility that ingests incoming messages from explicitly unread one-to-one LinkedIn conversations into a private Portal. It does not use LinkedIn's API, send or edit LinkedIn messages, open ineligible conversations, follow links, or download attachments.

## What a report contains

The Portal receives the captured incoming messages required by the ingestion contract. Local terminal and Codex task output remains count-only, for example:

```text
Processed: 2 conversations; Captured: 3 messages; Created: 2; Duplicates: 1; Assumed duplicates: 0; Pending recovery: 0; Pending timestamps: 0
```

Names, message content, LinkedIn URLs, timestamps, credentials, cookies, and private sidecar contents never appear in terminal or Codex task output.

## Requirements

- Node.js 18 or newer
- macOS for the intended local Codex scheduling workflow
- an HTTPS `PORTAL_WEBHOOK_URL`
- a `PORTAL_CALL_SECRET`
- a LinkedIn account you can log into manually in a visible browser
- the Mac awake and signed in at scheduled times

## Local setup

```bash
cd linkedin-unread-reporter
npm install
npx playwright install chromium
npm test
npm run configure
npm run login
npm run scan
npm run deliver
npm run report
```

`npm run configure` asks for the Portal Webhook URL (`PORTAL_WEBHOOK_URL`) and `PORTAL_CALL_SECRET` without echoing either value. It requires HTTPS, transfers both through hidden PTY input, and writes a mode-`0600` `.env`. LinkedIn credentials are never requested or stored. Authentication lives only in the gitignored `.linkedin-browser-profile/` created by Playwright.

`npm run login` opens the persistent profile without opening conversation rows or contacting the Portal. Complete any LinkedIn login, CAPTCHA, or checkpoint manually. After the unread inbox is detected as ready twice, Chromium closes automatically and saves the session.

`npm run scan` is the supervised dry scan. Under the read-on-open boundary it opens only explicitly eligible unread one-to-one threads and saves private captured data in the mode-`0600` `.linkedin-unread-outbox.json`. A visible or hidden stable destination is validated as a direct-URL candidate and durably tracked as discard-only `preopen_pending` while metadata stabilizes. The final list-and-exact-candidate revalidation is the last observation; on success the reporter atomically replaces the marker with `capture_pending` and `recoveryMode: direct`, then immediately invokes navigation with no intervening await. A failed final revalidation removes the pre-open marker. A promotion failure before commit does not open and leaves pre-open state for startup discard. A failure or abort after rename may also prevent the current open but leave durable direct intent, which the next run recovers at least once. A crash after promotion is recovered directly, and legacy mode-less capture markers are migrated to direct recovery. LinkedIn navigation and local persistence cannot be atomic across two systems, so this intentionally provides at-least-once durability: external row state may race after the last observation and duplicate capture is possible, but Portal idempotency keys mitigate duplicates and message loss is avoided. Preview text is never treated as a destination. For a truly anchorless candidate, the exact unread row opens first and visible blockers are handled within the bounded authentication timeout. A canonical thread URL is accepted only when the same uniquely visible list identifies the clicked row as its sole active row; `onOpened` then persists `capture_pending` with `recoveryMode: direct` before readiness or extraction. If responsive markup removes the list, or blocker recovery finds the row read or missing, the reporter fails closed with no recovery marker. This truly anchorless path retains a narrow unavoidable crash window between opening and persistence. Extraction is checkpointed immediately afterward. The scan never calls the Portal. Because opening an eligible thread can change LinkedIn's read state, run this dry scan only when supervised. Review its count-only result, then explicitly approve `npm run deliver` before the first real Portal batch. Activate schedules only when the scan captured at least one message and the delivery's count-only acknowledgement proves `Created + Duplicates + Assumed duplicates > 0`. If the dry scan captured zero messages, or delivery made no HTTP request or produced no HTTP acknowledgement, defer all schedules and rerun setup after unread messages exist. `npm run report` performs the recurring capture-and-deliver workflow after setup is verified.

## Install as a standalone Codex skill

Share this GitHub repository with a teammate. In Codex, they can provide its URL and ask:

```text
Use $skill-installer to install yq7786/Linkedin-Unread-Reporter with --path linkedin-unread-reporter.
```

The complete reporter is installed with the skill, so no separate application clone or plugin installation is required. On the next turn, ask: `Use $linkedin-unread-reporter to set it up.` Codex installs dependencies, asks once in chat for `PORTAL_WEBHOOK_URL` and `PORTAL_CALL_SECRET` together in this format:

```text
PORTAL_WEBHOOK_URL: <https-url>
PORTAL_CALL_SECRET: <secret>
```

It transfers those values to the configurator through hidden PTY input, prepares the persistent LinkedIn login, runs the supervised dry scan, and asks for approval before the first `npm run deliver`. It creates the three fixed schedules only when count-only evidence shows both `capturedMessages > 0` and `Created + Duplicates + Assumed duplicates > 0`; otherwise, it must defer all schedules and tell the user to rerun setup after unread messages exist. The supplied values remain in that teammate's Codex chat history but are never repeated, logged, or embedded in an automation prompt.

If direct download fails because the local Python trust store cannot validate GitHub's certificate chain, retry the same named path with the installer's supported `--method git` option. Never disable TLS verification or use an unverified download.

## Default schedule

Create the three weekday schedules—7:00am, 12:00pm, and 4:00pm—in `Australia/Adelaide` only after count-only setup evidence shows `capturedMessages > 0` and a nonempty Portal acknowledgement total of `Created + Duplicates + Assumed duplicates > 0`. Otherwise, defer schedule creation and rerun setup after unread messages exist. Each task explicitly uses `gpt-5.6-sol` with medium reasoning, allocates a persistent PTY for `npm run report`, and dispatches at most one timestamp-only subagent for each of attempts 1–3 when the reporter requests normalization. Scheduled runs are local, require the Mac to be available, and are not backfilled after missed execution.

## Privacy and security

- `.env`, `.linkedin-browser-profile/`, the private outbox, timestamp sidecars, temporary files, and locks are gitignored.
- `.env`, `.linkedin-unread-outbox.json`, `.linkedin-timestamp-work.json`, and `.linkedin-timestamp-results.json` are written with mode `0600`.
- The durable outbox supports checkpoint and recovery. Timestamp-only subagents never read it. The operating agent may read `.env`, the outbox, and timestamp sidecars when debugging.
- No LinkedIn username, password, cookie, name, message content, timestamp, or thread identifier is logged.
- Portal credentials never belong in a shell command, command-line argument, automation prompt, or task output.
- Capture fails closed when eligibility, unread state, thread identity, unread boundary, direction, message content, or timestamp is ambiguous.
