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
Use $linkedin-unread-reporter to run the scheduled LinkedIn unread report. Work from the skill's installed directory. Allocate and use a persistent PTY to start `npm run report`, then monitor that same PTY process/session until it exits. Whenever it prints `Timestamp normalization required: N item(s), attempt X of 3.`, dispatch exactly one timestamp-only subagent for each emitted marker and attempt, never more than one for that marker/attempt, then resume monitoring the same PTY process/session. Handle at most one subagent for each of attempt 1 of 3, attempt 2 of 3, and attempt 3 of 3; let the reporter use local fallback after attempt three. Never pass names, message content, or LinkedIn URLs; also never pass timestamps, credentials, outbox data, sidecar contents, or absolute paths between the parent and subagent or into the final task output. If the visible browser requires login, CAPTCHA, checkpoint, or identity verification, state only which manual action is required and allow up to 15 minutes. Return count-only success fields or a sanitized error.
```

The prompt deliberately tells the parent to allocate a persistent PTY, run `npm run report`, monitor that same PTY process/session, and respond to each marker. It contains neither secrets nor absolute paths.

## Timestamp-only subagent protocol

The reporter may print `Timestamp normalization required: N item(s), attempt X of 3.` after atomically writing the private `.linkedin-timestamp-work.json` sidecar. For each distinct attempt marker, the parent must dispatch exactly one subagent, and it must be the timestamp-only subagent below. The three possible markers correspond to attempt 1 of 3, attempt 2 of 3, and attempt 3 of 3. Do not dispatch speculatively, retry an attempt with another subagent, or dispatch more than three total.

Give the subagent exactly this task:

```text
Work only in the installed linkedin-unread-reporter skill directory. Read the private
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

The parent continues monitoring the same PTY process/session after each dispatch. It never reads either timestamp sidecar itself and never passes names, message content, or LinkedIn URLs. If a result is missing or invalid, the reporter removes the private sidecars and emits the next attempt marker. After attempt three, dispatch nothing further and let the reporter use local fallback after attempt three. Neither timestamp values nor relative labels may enter the final Codex task output.

## Verification

After creation, inspect all schedules and confirm:

1. recurrence is Monday–Friday at 7:00am, 12:00pm, and 4:00pm;
2. timezone is `Australia/Adelaide`;
3. execution is local and status is active;
4. model is `gpt-5.6-sol` and reasoning effort is `medium`;
5. count-only setup evidence shows the dry scan captured at least one message and `Created + Duplicates + Assumed duplicates > 0` for the approved delivery;
6. the prompt contains no credential, sensitive data, or absolute path;
7. every task invokes `$linkedin-unread-reporter` and runs the same `npm run report` entry point in a persistent terminal session;
8. the parent dispatches exactly one timestamp-only subagent for each emitted attempt marker, never more than attempts 1–3; and
9. all parent, subagent, and final task responses remain count-only.
