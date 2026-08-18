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
cd linkedin-unread-reporter
npm install
npx playwright install chromium
npm test
npm run configure
npm run login
npm run scan
npm run slack-test
npm run report
```

`npm run configure` asks for the webhook without echoing it and writes a mode-`0600` `.env`. LinkedIn credentials are never requested or stored. Authentication lives only in the gitignored `.linkedin-browser-profile/` created by Playwright.

`npm run login` opens that persistent profile without scanning rows or contacting Slack. Complete any LinkedIn login, CAPTCHA, or checkpoint manually. After the unread inbox is detected as ready twice, Chromium closes automatically and saves the session. `npm run scan` then reopens Chromium with that saved profile, performs the read-only dry scan, and closes it again.

## Install as a standalone Codex skill

Share this GitHub repository with a teammate. In Codex, they can provide its URL and ask:

```text
Use $skill-installer to install yq7786/Linkedin-Unread-Reporter with --path linkedin-unread-reporter.
```

The complete reporter is installed with the skill, so no separate application clone or plugin installation is required. On the next turn, ask: `Use $linkedin-unread-reporter to set it up.` Codex installs dependencies, asks for the Slack webhook in chat, transfers it to the configurator through hidden PTY input, prepares the persistent LinkedIn login, runs the supervised dry scan, verifies Slack delivery, and creates the three fixed schedules. The webhook therefore remains in that teammate's Codex chat history, but it is never repeated, logged, or embedded in an automation prompt.

If direct download fails because the local Python trust store cannot validate GitHub's certificate chain, retry the same named path with the installer's supported `--method git` option. Never disable TLS verification or use an unverified download.

## Default schedule

Every installation uses three weekday schedules—7:00am, 12:00pm, and 4:00pm—in `Australia/Adelaide`, including daylight-saving changes. Scheduled runs are local, require the Mac to be available, and are not backfilled after missed execution.

## Privacy and security

- `.env` and `.linkedin-browser-profile/` are gitignored.
- No LinkedIn username, password, cookies, message preview, or thread identifier is logged.
- The Slack webhook never belongs in a Codex automation prompt or command history.
- Scans fail closed if a conversation appears active or a detail pane is present.
- The scanner stops after 50 eligible rows and marks an early-capped report as truncated.
