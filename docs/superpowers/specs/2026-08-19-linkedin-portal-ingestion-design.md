# LinkedIn Portal Ingestion Design

## Purpose

Replace the current Slack summary workflow with a durable portal-ingestion workflow. The reporter will open eligible unread LinkedIn conversations, capture individual inbound unread messages, checkpoint them locally before moving to the next conversation, normalize timestamps, and deliver one idempotent batch to a portal webhook.

The portal becomes the source of truth for message read/unread state. Opening a conversation may mark it read in LinkedIn, and that side effect is accepted. Newly inserted database records default to unread; the reporter does not send a `status` field.

## Scope

The workflow supports one shared LinkedIn account and one-to-one conversations with real people. It excludes group, Sponsored, and automated threads. Each scheduled run processes at most 50 unread conversations. Conversations beyond the cap are not opened and remain unread for a later run.

The workflow captures:

- displayed lead name;
- each eligible unread inbound message;
- visible plain-text content, preserving internal line breaks and emojis while normalizing line endings and trimming surrounding whitespace;
- non-text message type and visible label, without downloading media or following attachment links;
- message sent time, original time label, and whether the resolved time is exact or estimated; and
- validated direct LinkedIn conversation URL.

The workflow does not capture outbound messages, older read history, group conversations, raw HTML, attachment contents, or a source-account identifier.

## Architecture

### 1. Private configuration

Setup asks for `PORTAL_WEBHOOK_URL` and `PORTAL_CALL_SECRET` instead of `SLACK_WEBHOOK_URL`. The configurator writes both to the existing private `.env` file with mode `0600`.

`PORTAL_WEBHOOK_URL` must be HTTPS in normal operation. The reporter sends `PORTAL_CALL_SECRET` in the `X-Portal-Call-Secret` header. Neither value may appear in command arguments, process output, automation prompts, logs, exception text, or test fixtures.

An existing `SLACK_WEBHOOK_URL` remains untouched but is ignored. Slack delivery, Slack tests, Slack report formatting, and Slack setup are removed from the active workflow.

### 2. Durable outbox

The reporter uses one gitignored atomic JSON outbox with file mode `0600`. It contains only undelivered work and is rewritten atomically after every state transition. A single-run lock prevents concurrent scheduled executions from modifying it simultaneously.

Outbox entries have one of four states:

- `preopen_pending`: a direct-URL candidate is durably checkpointed but is not known to have opened; it is discard-only and never eligible for direct recovery;
- `capture_pending`: durable at-least-once direct intent exists and `recoveryMode` is `direct`;
- `timestamp_pending`: message content is durable, but one or more relative timestamps still need normalization; or
- `ready`: complete message records are ready for portal delivery.

Acknowledged records are deleted immediately. No delivered history or long-term contact queue is stored locally.

### 3. Unread-list discovery

The browser navigates directly to `https://www.linkedin.com/messaging/?filter=unread` and retains the existing visible-login/checkpoint recovery behavior. Before opening any thread it requires one visible pressed Unread control, one visible conversation list, no active row, and no visible detail pane.

The scanner identifies at most 50 eligible one-to-one human rows. For each row it captures the displayed lead name, explicit unread state, available unread count, stable row identity, and direct thread URL when an anchor is exposed. A relative thread URL is resolved against `https://www.linkedin.com` and must match the expected LinkedIn messaging-thread path.

### 4. One-conversation-at-a-time capture

The reporter processes one row at a time rather than retaining live row handles. Before opening, it safely extracts and validates the row itself when it is an anchor, descendant visible or hidden anchors, and allowlisted stable destination attributes; preview text is never a destination source. A direct-URL candidate is first persisted as `preopen_pending` with safe identity and count metadata. Metadata stabilization continues while the marker remains pre-open. The reporter then performs the final list-and-exact-candidate revalidation as its last external observation. A conclusive failure removes `preopen_pending`. A success atomically replaces it with `capture_pending` and `recoveryMode: direct`, after which navigation is invoked immediately with no intervening awaited revalidation or persistence. If promotion fails before the atomic rename commits, navigation is not invoked and the remaining `preopen_pending` is discarded on the next capture run before ordinary unread discovery. If an error or abort is observed after rename or directory synchronization, navigation is still not invoked in that run but disk may already contain `capture_pending/direct`; startup therefore direct-recovers it at least once.

LinkedIn navigation and the local outbox cannot be committed atomically across two systems. The design therefore chooses explicit at-least-once intent based on the last verified eligibility observation. A crash after promotion but before or during navigation is recovered directly, preventing message loss. LinkedIn may change external row state after the final observation, or a crash may lead to duplicate capture, but stable message IDs and fallback Portal idempotency keys mitigate duplicates. Legacy mode-less `capture_pending` entries are conservatively treated as already-open work and atomically migrated to `direct` before URL recovery.

If the row truly exposes no destination, the reporter clicks that row and polls the existing visible blocker classifier within the bounded authentication timeout. After blocker recovery it returns to unread, re-resolves the exact unread candidate, and clicks again. A canonical thread URL is accepted only while the same uniquely visible conversation list identifies the clicked stable row as its sole active row. `onOpened` then persists `capture_pending` with `recoveryMode: direct` before readiness or extraction. If responsive markup removes the list, or recovery finds the row read or missing, the reporter fails closed with no recovery marker. This truly anchorless path retains a narrow unavoidable crash window between click and marker persistence. It never sends a LinkedIn message, edits content, follows attachment links, or downloads media.

Unread-message selection follows this order:

1. If LinkedIn exposes a reliable in-thread unread boundary, capture every inbound message after that boundary.
2. Otherwise, if the list row exposed a reliable unread count, capture that many newest inbound messages.
3. Otherwise, capture only the newest inbound message.

Outbound messages are never included. After extracting a conversation, the reporter atomically checkpoints its records before navigating back to the unread list. Because the open thread may disappear from the unread list, discovery restarts from the current list state rather than using stale DOM nodes.

### 5. Extraction recovery markers

If extraction fails after a thread is opened, the reporter retries by navigating directly to the validated thread URL up to three times during that run. If all attempts fail, it stores a `capture_pending` marker containing:

- displayed lead name;
- validated conversation URL;
- expected unread count when available;
- first failure time;
- attempt count; and
- recovery mode (`direct`).

The marker contains no message content because extraction did not succeed. At the beginning of later scheduled runs, stale `preopen_pending` entries are discarded first, legacy mode-less capture markers become `direct`, and then every `capture_pending` marker is recovered through its canonical URL before new unread rows. On success the marker is atomically replaced by normal message records; on continued failure it remains `direct` for the next run. If no reliable unread count was saved, recovery captures only the newest inbound message.

### 6. Timestamp normalization

For each message the browser first searches LinkedIn timestamp metadata such as `datetime`, `title`, `aria-label`, and any full timestamp exposed by a visible tooltip. Machine-readable full timestamps are normalized to ISO 8601 with `sentAtAccuracy: "exact"` and bypass model processing.

Relative labels are stored durably with the fixed run-level `scanStartedAt` anchor before normalization. After capture, Codex starts one bounded timestamp subagent for all relative-time items. The subagent receives only temporary item keys, raw relative labels, and `scanStartedAt`; it does not receive lead names, content, or LinkedIn URLs.

The subagent returns a normalized ISO 8601 value for each temporary key. Relative conversions use `sentAtAccuracy: "estimated"` and retain the original label as `sentAtRaw`. Malformed or incomplete subagent output is retried up to three total attempts. If all three attempts fail, deterministic local conversion uses the same fixed `scanStartedAt` anchor. A record is not portal-ready until it has a normalized `sentAt`.

### 7. Idempotency

Every message receives an `idempotencyKey`.

When LinkedIn exposes a stable message identifier, the key is derived from that identifier. Otherwise the reporter calculates SHA-256 over a canonical representation of:

- normalized displayed lead name;
- resolved `sentAt`; and
- validated direct conversation URL.

The raw relative label and fixed scan anchor ensure timestamp work is reproducible within the durable outbox. The portal enforces a unique constraint on `idempotencyKey` and returns `created` or `duplicate` for each acknowledged item.

## Portal payload

The reporter sends one batch per run:

```json
{
  "schemaVersion": "1",
  "batchId": "uuid",
  "capturedAt": "2026-08-19T03:07:00.000Z",
  "messages": [
    {
      "idempotencyKey": "string",
      "linkedinMessageId": "string-or-null",
      "leadName": "Displayed Name",
      "contentType": "text",
      "content": "Visible message content",
      "sentAt": "2026-08-19T02:05:00.000Z",
      "sentAtRaw": "2h",
      "sentAtAccuracy": "estimated",
      "conversationUrl": "https://www.linkedin.com/messaging/thread/opaque-id/"
    }
  ]
}
```

`contentType` distinguishes text from visible non-text types. `content` contains normalized visible text or the visible non-text label. The payload intentionally omits message status and source-account identity.

The portal response contains one result per idempotency key with status `created` or `duplicate`.

Network failures and non-2xx responses retain the complete unacknowledged batch. On a 2xx response, explicit `created` and `duplicate` items are removed. Per the accepted product decision, missing, malformed, or unknown per-item results on a 2xx response are treated as duplicates and removed, despite the documented risk that an incomplete successful response could cause data loss.

## Run sequence

Each run performs these stages in order:

1. Acquire the single-run lock.
2. Load and validate the private outbox.
3. Deliver existing `ready` records. If this delivery receives a network error or non-2xx response, stop before opening new LinkedIn conversations.
4. Atomically discard stale `preopen_pending` markers, migrate legacy capture markers to `direct`, and recover every `capture_pending` marker through its canonical URL.
5. Normalize existing `timestamp_pending` records.
6. Discover and process up to 50 new unread one-to-one conversations, checkpointing each immediately.
7. Normalize newly captured relative timestamps.
8. Deliver one final batch of all `ready` records.
9. Remove acknowledged records, persist remaining work atomically, and release the lock.

The existing weekday schedules remain 7:00am, 12:00pm, and 4:00pm in `Australia/Adelaide`. All three automations use `gpt-5.6-sol` with medium reasoning.

## Failure and privacy behavior

The reporter fails closed for unsafe list invariants, invalid or non-LinkedIn thread URLs, ambiguous message direction, visible login/CAPTCHA/checkpoint states, invalid portal configuration, outbox corruption, outbox write failure, and non-2xx portal delivery.

Terminal logs and Codex task output contain aggregate counts only, for example captured messages, processed conversations, created records, duplicates, pending timestamp items, and pending recovery markers. They never include lead names, message content, timestamps, conversation URLs, browser cookies, outbox contents, or portal secrets.

The browser profile, `.env`, outbox, lock, and any atomic temporary outbox file are gitignored. Temporary files are private and removed after successful atomic replacement.

## Setup and migration

The skill setup workflow changes to:

1. verify installation and dependencies;
2. ask for Portal Webhook URL and `PORTAL_CALL_SECRET` through the approved secret-transfer workflow;
3. save `PORTAL_WEBHOOK_URL` and `PORTAL_CALL_SECRET` to `.env` with mode `0600`;
4. establish the persistent LinkedIn login;
5. run a supervised capture dry run that does not contact the portal;
6. obtain approval before a portal delivery test;
7. verify one real portal batch and acknowledgement behavior; and
8. create or update the three fixed schedules.

Existing Slack configuration is not deleted. Existing schedules keep their recurrence, timezone, local execution, model, reasoning effort, and project target while their runtime behavior changes from Slack reporting to portal ingestion.

## Verification strategy

Tests and sanitized fixtures must cover:

- one-to-one eligibility and exclusion of group, Sponsored, and automated rows;
- pre-open thread URL extraction and validated post-open fallback;
- processing list virtualization without stale row clicks;
- multiple unread inbound messages through a boundary or saved count;
- newest-inbound fallback when no reliable boundary exists;
- exclusion of outbound and older read messages;
- plain-text normalization and non-text visible labels without downloads;
- exact timestamp metadata and visible tooltip extraction;
- one timestamp-only subagent batch, three attempts, and deterministic fallback;
- exact versus estimated timestamp accuracy;
- stable-message-ID and fallback SHA-256 idempotency keys;
- atomic per-conversation checkpointing;
- `preopen_pending`, `capture_pending`, `timestamp_pending`, and `ready` outbox transitions;
- private `0600` outbox creation, atomic rewrites, lock behavior, and corruption failure;
- discard-only pre-open markers and recovery markers across scheduled runs;
- HTTPS portal validation and `X-Portal-Call-Secret` authentication;
- created and duplicate acknowledgement removal;
- configured treatment of missing or malformed 2xx per-item results as duplicates;
- network and non-2xx retention;
- count-only logs and secret/content redaction;
- removal of Slack from active runtime and setup; and
- the unchanged 50-conversation cap and three Adelaide schedules.
