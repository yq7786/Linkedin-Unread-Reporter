# Local Codex automation setup

Read this reference only when creating, updating, or verifying recurring reports.

## Inputs

Ask for the user's desired weekdays, local times, and IANA timezone. Confirm the timezone explicitly so daylight-saving changes follow the named zone rather than a fixed UTC offset.

The original requested schedule is:

- Monday–Friday at 7:00am
- Monday–Friday at 12:00pm
- Monday–Friday at 4:00pm
- IANA timezone: `Australia/Adelaide`

Do not apply that default to another user unless they request it.

## Automation rules

- Use Codex's automation tool, not hand-written directives.
- Create one local recurring automation per requested time so failures and history are independent.
- Target the current repository clone as the automation working directory.
- Use the user's IANA timezone so daylight-saving transitions are automatic.
- Set each task active only after tests, a supervised scan, and Slack delivery verification succeed.
- Put no webhook, LinkedIn credential, browser cookie, contact name, or machine-specific path in the prompt body. The automation working-directory field carries the clone location.
- Do not backfill missed executions.

Use this credential-free task prompt:

```text
Run the LinkedIn unread reporter in this project with `npm run report`. If the visible browser requires login, CAPTCHA, checkpoint, or identity verification, tell me which manual action is required and allow up to 15 minutes. Report only success counts or sanitized errors; never include names, previews, cookies, or webhook values in the Codex task output.
```

## Verification

After creation, inspect all schedules and confirm:

1. recurrence matches the requested weekdays and local time;
2. timezone is the requested IANA zone;
3. execution is local against this clone;
4. status is active;
5. prompt contains no credential or absolute clone path; and
6. all tasks invoke the same `npm run report` entry point.
