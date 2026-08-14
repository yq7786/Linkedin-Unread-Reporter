# LinkedIn Unread Reporter

A local, read-only Playwright utility that scans LinkedIn's **Unread** conversation list and sends a minimal report to a Slack incoming webhook. It does not use LinkedIn's API, open conversations, read message bodies, reply, or store contact data.

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

- Node.js 18 or newer
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

## Install as a standalone Codex skill

Share this GitHub repository with a teammate. In Codex, they can provide its URL and ask:

```text
Use $skill-installer to install this GitHub repository with --path . --name linkedin-unread-reporter.
```

The complete reporter is installed with the skill, so no separate application clone or plugin installation is required. On the next turn, ask: `Use $linkedin-unread-reporter to set it up.` Codex installs dependencies, requests the Slack webhook through a hidden local prompt, runs the supervised LinkedIn scan, verifies Slack delivery, and creates the three fixed schedules.

## Default schedule

Every installation uses three weekday schedules—7:00am, 12:00pm, and 4:00pm—in `Australia/Adelaide`, including daylight-saving changes. Scheduled runs are local, require the Mac to be available, and are not backfilled after missed execution.

## Privacy and security

- `.env` and `.linkedin-browser-profile/` are gitignored.
- No LinkedIn username, password, cookies, message preview, or thread identifier is logged.
- The Slack webhook never belongs in a Codex automation prompt or command history.
- Scans fail closed if a conversation appears active or a detail pane is present.
- The scanner stops after 50 eligible rows and marks an early-capped report as truncated.
