---
name: linkedin-unread-reporter
description: Set up, verify, run, troubleshoot, or locally schedule the LinkedIn Unread Reporter in its repository clone. Use when a user wants LinkedIn unread conversation names and counts sent to Slack without the LinkedIn API, wants to configure the persistent browser login or Slack webhook, or wants Codex automations for recurring reports.
---

# LinkedIn Unread Reporter

Operate the repository's read-only Playwright reporter. Never ask for or store LinkedIn credentials, never put a Slack webhook in chat or an automation prompt, and never open a conversation row during scanning.

## Verify the clone

Work only in a clone containing all of:

- `package.json` with package name `linkedin-unread-reporter`
- `src/cli.js`
- `.env.example`

If any marker is missing, stop and tell the user to clone the application repository and open that clone as the Codex project. Do not invent a machine-specific path.

## Setup workflow

1. Explain that automated browser access may conflict with LinkedIn's User Agreement and may trigger checkpoints or restrictions. Obtain confirmation before the first live scan.
2. Verify Node.js 20 or newer, run `npm install`, and run `npx playwright install chromium` if the browser runtime is absent.
3. Run `npm test`. Stop on failures and diagnose them before using LinkedIn or Slack.
4. If `.env` lacks `SLACK_WEBHOOK_URL`, run `npm run configure` in an interactive local terminal. Tell the user to paste their current webhook into that hidden prompt. Do not ask them to paste it into chat, place it in a shell command, echo it, or read it back.
5. Run `npm run scan` for a supervised dry scan. A visible persistent browser opens. If LinkedIn shows login, CAPTCHA, checkpoint, or identity verification, tell the user exactly which manual action to complete in that browser and wait up to 15 minutes. Never automate or bypass the challenge.
6. Confirm the scan completes without names in terminal logs. Obtain confirmation before `npm run slack-test`, because it sends one external Slack message.
7. Run `npm run report` only when the user asks for or approves a real report.

## Safety invariants

- Navigate directly to `https://www.linkedin.com/messaging/?filter=unread`.
- Inspect conversation-list rows only. Never click or open a conversation, send a message, or inspect a message detail pane.
- Require LinkedIn's explicit unread state. Exclude only explicit Sponsored or automated-conversation labels; do not infer automation from preview text.
- Stop when the list is stable with no Load more control, or after 50 eligible rows. Do not replace this with a read-message streak rule.
- Fail closed if the Unread button is not pressed, a row is active, or a detail pane is visible.
- Keep `.env` and `.linkedin-browser-profile/` local and gitignored. Store no contact queue, names, previews, credentials, cookies, or thread identifiers in logs.
- Never reuse a revoked or previously disclosed webhook. Each user supplies their own current webhook locally.

## Scheduling

When the user asks for recurring reports, read [references/automation-setup.md](references/automation-setup.md) completely. Use Codex's automation capability to create or update local schedules against the current clone; do not emit raw automation directives or embed credentials.

## Troubleshooting

- For login/CAPTCHA/checkpoint failures, keep the visible browser open for manual recovery. If unresolved after 15 minutes, report failure and do not send Slack.
- For selector or invariant failures, do not weaken the safety checks. Reproduce with a sanitized fixture and update tests before code.
- For Slack failures, report only the status category or sanitized network error. Never print the webhook or Slack response body.
- Scheduled runs are local: the computer must be awake, signed in, and able to display the headed browser. Missed runs are not backfilled.
