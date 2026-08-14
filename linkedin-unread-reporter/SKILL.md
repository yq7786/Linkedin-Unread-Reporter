---
name: linkedin-unread-reporter
description: Set up, verify, run, troubleshoot, or locally schedule the self-contained LinkedIn Unread Reporter skill. Use when a user wants LinkedIn unread conversation names and counts sent to Slack without the LinkedIn API, wants to configure the persistent browser login or Slack webhook, or wants the fixed recurring Adelaide reports.
---

# LinkedIn Unread Reporter

Operate the read-only Playwright reporter installed beside this `SKILL.md`. Never ask for or store LinkedIn credentials, never repeat a supplied Slack webhook or put it in an automation prompt, and never open a conversation row during scanning.

## Verify the installation

Work from the directory containing this `SKILL.md`. Require all of:

- `package.json` with package name `linkedin-unread-reporter`
- `src/cli.js`
- `.env.example`
- `references/automation-setup.md`

If any marker is missing, stop immediately before installing dependencies or taking any setup action. Tell the user to remove the incomplete destination and reinstall `yq7786/Linkedin-Unread-Reporter` with `--path linkedin-unread-reporter`. If direct download failed because of a certificate-chain error, retry through the installer's supported `--method git`; never disable TLS verification. Do not invent a machine-specific path or require a separate application clone.

## Setup workflow

1. Verify Node.js 18 or newer, run `npm install`, and run `npx playwright install chromium` if the browser runtime is absent.
2. If `.env` lacks `SLACK_WEBHOOK_URL`, tell the user once that the supplied value will remain in chat history, then ask exactly: **Please provide `SLACK_WEBHOOK_URL`.** After the response, do not quote, summarize, validate visibly, or repeat it. Start `npm run configure` in an interactive PTY and submit the supplied value through its hidden input. Never place the value in a shell command, command-line argument, environment assignment, patch, log, automation prompt, or task output. Do not read `.env` back; verify only the configurator's success message and that `.env` has mode `0600`.
3. Run `npm run scan` for a supervised dry scan. A visible persistent browser opens. If LinkedIn shows login, CAPTCHA, checkpoint, or identity verification, tell the user exactly which manual action to complete in that browser and wait up to 15 minutes. Never automate or bypass the challenge.
4. Confirm the scan completes without names in terminal logs. Obtain confirmation before `npm run slack-test`, because it sends one external Slack message.
5. After the scan and Slack delivery verification succeed, read [references/automation-setup.md](references/automation-setup.md) completely and create or update the three fixed local schedules automatically.
6. Run `npm run report` only when the user asks for or approves a real report.

## Safety invariants

- Navigate directly to `https://www.linkedin.com/messaging/?filter=unread`.
- Inspect conversation-list rows only. Never click or open a conversation, send a message, or inspect a message detail pane.
- Require LinkedIn's explicit unread state. Exclude only explicit Sponsored or automated-conversation labels; do not infer automation from preview text.
- Stop when the list is stable with no Load more control, or after 50 eligible rows. Do not replace this with a read-message streak rule.
- Fail closed if the Unread button is not pressed, a row is active, or a detail pane is visible.
- Keep `.env` and `.linkedin-browser-profile/` local and gitignored. Store no contact queue, names, previews, credentials, cookies, or thread identifiers in logs.
- Never reuse a revoked or previously disclosed webhook. Each user supplies their own current webhook once; after collection, keep it only in the local `.env` and the already accepted chat history.

## Scheduling

Use Codex's automation capability to create or update local schedules against the current local project. Do not emit raw automation directives or embed credentials. Always use the three fixed weekday times and `Australia/Adelaide` timezone defined in [references/automation-setup.md](references/automation-setup.md); do not ask for alternatives.

## Troubleshooting

- For login/CAPTCHA/checkpoint failures, keep the visible browser open for manual recovery. If unresolved after 15 minutes, report failure and do not send Slack.
- For selector or invariant failures, do not weaken the safety checks. Reproduce with a sanitized fixture and update tests before code.
- For Slack failures, report only the status category or sanitized network error. Never print the webhook or Slack response body.
- Scheduled runs are local: the computer must be awake, signed in, and able to display the headed browser. Missed runs are not backfilled.
