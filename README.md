# LinkedIn Unread Reporter

A local, read-only Playwright utility that scans LinkedIn's **Unread** conversation list and sends a minimal report to a Slack incoming webhook. It does not use LinkedIn's API, open conversations, read message bodies, reply, or store contact data.

> [!WARNING]
> Automated browser access may conflict with LinkedIn's [User Agreement](https://www.linkedin.com/legal/user-agreement) and can trigger account checkpoints or restrictions. Use this project only after assessing that risk. It does not bypass login, CAPTCHA, or security controls.

## What a report contains

```text
LinkedIn unread message: 3
Scanned: 12:00pm Australia/Adelaide

• Contact name
• Contact name
• Contact name

Open LinkedIn Unread Inbox
```

Only the displayed conversation name is used. Exact duplicate names are grouped for display while the heading retains the conversation-row count. Reports repeat all currently outstanding unread conversations.

## Requirements

- Node.js 20 or newer
- macOS for the intended local Codex scheduling workflow
- a Slack incoming webhook
- a LinkedIn account you can log into manually in a visible browser
- the Mac awake and signed in at scheduled times

## Local setup

```bash
npm install
npx playwright install chromium
npm test
npm run configure
npm run scan
npm run slack-test
npm run report
```

`npm run configure` asks for the webhook without echoing it and writes a mode-`0600` `.env`. LinkedIn credentials are never requested or stored. Authentication lives only in the gitignored `.linkedin-browser-profile/` created by Playwright. If LinkedIn shows login, CAPTCHA, or a checkpoint, complete it manually in the visible browser.

## Codex plugin setup

This repository includes a repo marketplace and a `linkedin-unread-reporter` plugin. After the repository is published, replace `<owner>/<repository>` with its GitHub location:

```bash
codex plugin marketplace add <owner>/<repository>
codex plugin install linkedin-unread-reporter
```

Open your local clone in Codex and ask: `Use linkedin-unread-reporter to set this project up.` The skill verifies the clone, configures it locally, runs a supervised scan, and can create local scheduled tasks for your chosen weekdays, times, and IANA timezone.

## Default schedule

The original installation uses three weekday schedules—7:00am, 12:00pm, and 4:00pm—in `Australia/Adelaide`, including daylight-saving changes. Scheduled runs are local, require the Mac to be available, and are not backfilled after missed execution.

## Privacy and security

- `.env` and `.linkedin-browser-profile/` are gitignored.
- No LinkedIn username, password, cookies, message preview, or thread identifier is logged.
- The Slack webhook never belongs in a Codex automation prompt or command history.
- Scans fail closed if a conversation appears active or a detail pane is present.
- The scanner stops after 50 eligible rows and marks an early-capped report as truncated.

See the [approved design](docs/superpowers/specs/2026-08-14-linkedin-unread-reporter-design.md) for complete behavior and risk boundaries.
