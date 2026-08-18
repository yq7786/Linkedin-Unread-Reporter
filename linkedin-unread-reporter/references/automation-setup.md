# Fixed local Codex automation setup

Read this reference only when creating, updating, or verifying recurring reports.

## Required schedule

Create these schedules for every installation without asking for alternative weekdays, times, or timezone:

- Monday–Friday at 7:00am
- Monday–Friday at 12:00pm
- Monday–Friday at 4:00pm
- IANA timezone: `Australia/Adelaide`

Keep the named IANA timezone so daylight-saving transitions remain automatic rather than using a fixed UTC offset.

## Automation rules

- Use Codex's automation tool, not hand-written directives.
- Create one active local recurring automation per required time so failures and history are independent.
- Set these fields explicitly on every automation create or update; do not inherit the current task or application defaults:
  - model: `gpt-5.6-sol`
  - reasoning effort: `medium`
- Target the user's current local Codex project. Invoke the globally installed `$linkedin-unread-reporter` skill so it runs `npm run report` from its own installed directory.
- Activate the tasks only after a supervised scan and Slack delivery verification succeed.
- Put no webhook, LinkedIn credential, browser cookie, contact name, or machine-specific path in the prompt body.
- Do not backfill missed executions.

Use this credential-free task prompt:

```text
Use $linkedin-unread-reporter to run the scheduled LinkedIn unread report from the skill's installed directory with `npm run report`. If the visible browser requires login, CAPTCHA, checkpoint, or identity verification, tell me which manual action is required and allow up to 15 minutes. Report only success counts or sanitized errors; never include names, previews, cookies, or webhook values in the Codex task output.
```

## Verification

After creation, inspect all schedules and confirm:

1. recurrence is Monday–Friday at 7:00am, 12:00pm, and 4:00pm;
2. timezone is `Australia/Adelaide`;
3. execution is local;
4. status is active;
5. model is `gpt-5.6-sol`;
6. reasoning effort is `medium`;
7. prompt contains no credential or absolute clone path; and
8. all tasks invoke `$linkedin-unread-reporter` and the same `npm run report` entry point.
