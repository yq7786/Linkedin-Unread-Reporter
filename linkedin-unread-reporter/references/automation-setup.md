# Fixed local Codex automation setup

Read this reference only when creating, updating, verifying, or manually supervising recurring reports.

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
- Target the user's current local Codex project. Invoke the globally installed `$linkedin-unread-reporter` skill, which locates its own installed directory.
- Activate the tasks only when the supervised `npm run scan` captured at least one message and the user's approved `npm run deliver` acknowledged a nonempty batch, proven from count-only output by `Created + Duplicates + Assumed duplicates > 0`.
- If the dry scan captured zero messages, or delivery made no HTTP request or produced no HTTP acknowledgement, defer all schedules and tell the user to rerun setup after unread messages exist.
- Put no Portal credential, LinkedIn credential, browser cookie, name, message content, LinkedIn URL, timestamp, sidecar content, or machine-specific/absolute path in the prompt or task output.
- Do not backfill missed executions.

Use this credential-free task prompt exactly:

```text
Use $linkedin-unread-reporter to run the scheduled LinkedIn unread report. Work from the skill's installed directory. Allocate and use a persistent PTY to start `npm run report`, then monitor that same PTY process/session until it exits. If it prints `Timestamp normalization required: N item(s).`, the same operating agent reads $HOME/.linkedin-unread-reporter/.linkedin-timestamp-work.json, converts every relativeTime to an ISO-8601 sentAt using its scanStartedAt anchor, copies the top-level workId and each itemKey verbatim, atomically writes mode-0600 .linkedin-timestamp-results.json, and reruns `npm run report` once in the same persistent PTY. Do not dispatch a subagent. Never pass names, message content, or LinkedIn URLs; also never put timestamps, credentials, outbox data, sidecar contents, or absolute paths into the final task output. If the visible browser requires login, CAPTCHA, checkpoint, or identity verification, state only which manual action is required and allow up to 15 minutes. Return count-only success fields or a sanitized error.
```

The prompt deliberately tells the parent to allocate a persistent PTY, run `npm run report`, monitor that same PTY process/session, and convert leftover relative labels itself. It contains neither secrets nor absolute paths.

## Operating-agent timestamp conversion

The reporter converts parseable relative labels in process. If any leftovers remain, it prints `Timestamp normalization required: N item(s).` after atomically writing the private `.linkedin-timestamp-work.json` sidecar in `$HOME/.linkedin-unread-reporter`, then exits without waiting. The same operating agent — not a subagent — must convert those leftovers and rerun the same command. Do not dispatch a timestamp-only subagent.

The operating agent uses exactly this conversion task:

```text
Work only in $HOME/.linkedin-unread-reporter. Read the private
.linkedin-timestamp-work.json file. It contains one opaque top-level workId; each item
contains only itemKey, relativeTime, and scanStartedAt fields. Convert every relativeTime
to an ISO-8601 sentAt value using its scanStartedAt anchor. Copy the top-level input workId
verbatim into the result and copy each input itemKey verbatim into the matching result;
never invent, renumber, normalize, or otherwise change a workId or itemKey. Atomically write mode-`0600`
.linkedin-timestamp-results.json with this value-free schema:
{"version":1,"workId":"<WORK-ID>","items":[{"itemKey":"timestamp-N","sentAt":"<ISO-8601>"}]}.
Here <WORK-ID> and timestamp-N mean the unchanged input values and <ISO-8601> means the
computed value; do not write any placeholder literally. Do not read the
outbox, browser profile, .env, lead names, message content, or LinkedIn URLs. Return
only the number of converted items.
```

After writing the result sidecar, rerun the same `npm run deliver` or `npm run report` command once. The reporter applies that result and continues. Neither timestamp values nor relative labels may enter the final Codex task output.

## Verification

After creation, inspect all schedules and confirm:

1. recurrence is Monday–Friday at 7:00am, 12:00pm, and 4:00pm;
2. timezone is `Australia/Adelaide`;
3. execution is local and status is active;
4. model is `gpt-5.6-sol` and reasoning effort is `medium`;
5. count-only setup evidence shows the dry scan captured at least one message and `Created + Duplicates + Assumed duplicates > 0` for the approved delivery;
6. the prompt contains no credential, sensitive data, or absolute path;
7. every task invokes `$linkedin-unread-reporter` and runs the same `npm run report` entry point in a persistent terminal session;
8. the same operating agent converts leftover relative labels from the timestamp work sidecar and reruns once, without dispatching a subagent; and
9. all parent and final task responses remain count-only.
