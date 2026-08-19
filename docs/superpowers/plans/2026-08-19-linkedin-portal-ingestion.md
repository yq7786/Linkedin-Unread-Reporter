# LinkedIn Portal Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Slack summaries with durable, idempotent ingestion of individual unread LinkedIn messages into an authenticated portal webhook.

**Architecture:** A single lock-holding workflow drains the durable outbox, recovers failed thread captures, opens and checkpoints unread conversations one at a time, normalizes relative timestamps through a timestamp-only Codex subagent bridge with deterministic fallback, and sends one portal batch. Browser extraction, durable state, timestamp normalization, portal delivery, and CLI orchestration remain separate modules with fail-closed interfaces.

**Tech Stack:** Node.js 18+, ECMAScript modules, Playwright 1.55.1, `node:test`, filesystem-backed atomic JSON, Codex scheduled automations.

---

## File structure

- `src/config.js`: validate portal configuration and local private-state paths.
- `src/configure.js`: collect and atomically save both portal secrets while preserving unrelated `.env` values.
- `src/outbox.js`: validate, lock, load, and atomically save the private durable outbox.
- `src/messages.js`: validate conversation URLs, normalize visible message content, select unread inbound messages, and create idempotency keys.
- `src/timestamps.js`: exact/relative timestamp normalization, sanitized subagent work/result files, retries, and local fallback.
- `src/portal.js`: authenticated batch transport and acknowledgement classification.
- `src/browser.js`: unread candidate discovery, safe thread opening, and thread-message extraction.
- `src/scanner.js`: one-conversation-at-a-time capture and recovery-marker orchestration.
- `src/workflow.js`: the lock-holding run sequence joining outbox, browser, timestamp, and portal modules.
- `src/cli.js`: count-only commands for configure, login, capture dry run, pending delivery, and scheduled workflow.
- `SKILL.md` and `references/automation-setup.md`: setup, timestamp-subagent protocol, and fixed schedules.
- Remove active Slack runtime files `src/report.js`, `src/slack.js`, `test/report.test.js`, and `test/slack.test.js` after portal coverage is green.

### Task 1: Portal configuration contract

**Files:**
- Modify: `linkedin-unread-reporter/test/config.test.js`
- Modify: `linkedin-unread-reporter/src/config.js`
- Modify: `linkedin-unread-reporter/.env.example`

- [ ] **Step 1: Write failing portal configuration tests**

Add tests using the real `loadConfig` API:

```js
test('loadConfig requires an HTTPS portal URL and call secret for delivery', () => {
  const config = loadConfig({
    env: {
      PORTAL_WEBHOOK_URL: 'https://portal.example.test/hooks/linkedin',
      PORTAL_CALL_SECRET: 'private-call-secret',
    },
    projectRoot: '/tmp/reporter',
    requirePortal: true,
  });
  assert.equal(config.portalWebhookUrl, 'https://portal.example.test/hooks/linkedin');
  assert.equal(config.portalCallSecret, 'private-call-secret');
  assert.equal(config.outboxPath, '/tmp/reporter/.linkedin-unread-outbox.json');
  assert.equal(config.outboxLockPath, '/tmp/reporter/.linkedin-unread-outbox.lock');
});

test('loadConfig rejects HTTP portal URLs without echoing secrets', () => {
  assert.throws(() => loadConfig({
    env: {
      PORTAL_WEBHOOK_URL: 'http://portal.example.test/hooks/linkedin',
      PORTAL_CALL_SECRET: 'do-not-print-this',
    },
    requirePortal: true,
  }), (error) => /HTTPS/.test(error.message) && !/do-not-print-this/.test(error.message));
});
```

- [ ] **Step 2: Run the focused test and verify red**

Run: `node test/config.test.js`

Expected: FAIL because `requirePortal`, `portalWebhookUrl`, and `portalCallSecret` do not exist.

- [ ] **Step 3: Replace Slack configuration fields**

Update `DEFAULTS` and `loadConfig` to return this stable interface:

```js
{
  projectRoot,
  portalWebhookUrl,
  portalCallSecret,
  browserProfilePath,
  outboxPath,
  outboxLockPath,
  timestampWorkPath,
  timestampResultPath,
  unreadUrl,
  maxUnreadConversations,
  authTimeoutMs,
  reportTimezone,
}
```

Use `requirePortal = true`, require an HTTPS URL with no embedded credentials, require a non-empty call secret, preserve Node 18-compatible validation, and expand `redactSecrets` to redact both portal URLs and `PORTAL_CALL_SECRET` values supplied through a `secrets` argument.

Update `.env.example` to list `PORTAL_WEBHOOK_URL` and `PORTAL_CALL_SECRET`, retain optional non-secret browser settings, and remove Slack as an active example.

- [ ] **Step 4: Run config tests and commit**

Run: `node test/config.test.js`

Expected: PASS.

```bash
git add linkedin-unread-reporter/src/config.js linkedin-unread-reporter/test/config.test.js linkedin-unread-reporter/.env.example
git commit -m "feat: add portal ingestion configuration"
```

### Task 2: Private two-value configurator

**Files:**
- Modify: `linkedin-unread-reporter/test/configure.test.js`
- Modify: `linkedin-unread-reporter/src/configure.js`

- [ ] **Step 1: Write failing configurator tests**

Add a test that proves both values are stored, Slack is preserved, and no secret is returned:

```js
test('configurePortal atomically stores portal values and preserves Slack', async () => {
  const prompts = [];
  const answers = [
    'https://portal.example.test/hooks/linkedin',
    'private-call-secret',
  ];
  const result = await configurePortal({
    envPath,
    askSecret: async (prompt) => {
      prompts.push(prompt);
      return answers.shift();
    },
  });
  const text = await fs.readFile(envPath, 'utf8');
  assert.match(text, /^SLACK_WEBHOOK_URL=legacy$/m);
  assert.match(text, /^PORTAL_WEBHOOK_URL=https:\/\/portal\.example\.test\/hooks\/linkedin$/m);
  assert.match(text, /^PORTAL_CALL_SECRET=private-call-secret$/m);
  assert.deepEqual(result, { configured: true, envPath });
  assert.equal(prompts.length, 2);
});
```

Retain the existing atomic-rename-failure test and extend it to prove `.env.tmp-*` is deleted without exposing either value.

- [ ] **Step 2: Run the focused test and verify red**

Run: `node test/configure.test.js`

Expected: FAIL because `configurePortal` is not exported.

- [ ] **Step 3: Implement `configurePortal`**

Replace `configureSlack` with:

```js
export async function configurePortal({
  envPath = path.join(PROJECT_ROOT, '.env'),
  askSecret = (prompt) => readHiddenSecret({ prompt }),
  fileSystem = fs,
  processId = process.pid,
} = {}) {
  const portalWebhookUrl = await askSecret('Portal Webhook URL (input hidden): ');
  const portalCallSecret = await askSecret('PORTAL_CALL_SECRET (input hidden): ');
  loadConfig({
    env: { PORTAL_WEBHOOK_URL: portalWebhookUrl, PORTAL_CALL_SECRET: portalCallSecret },
    projectRoot: path.dirname(envPath),
    requirePortal: true,
  });
  // Read existing text, update only the two portal keys, atomically rename,
  // chmod 0600, remove the temporary file in finally, and return no values.
  return { configured: true, envPath };
}
```

Keep `updateEnvText` generic so an existing Slack value remains untouched.

- [ ] **Step 4: Run configurator tests and commit**

Run: `node test/configure.test.js`

Expected: PASS.

```bash
git add linkedin-unread-reporter/src/configure.js linkedin-unread-reporter/test/configure.test.js
git commit -m "feat: configure portal webhook credentials"
```

### Task 3: Atomic outbox and run lock

**Files:**
- Create: `linkedin-unread-reporter/src/outbox.js`
- Create: `linkedin-unread-reporter/test/outbox.test.js`
- Modify: `linkedin-unread-reporter/.gitignore`

- [ ] **Step 1: Write failing outbox tests**

Cover creation, validation, atomic replacement, permissions, lock exclusion, cleanup, and corrupt JSON:

```js
test('saveOutbox writes versioned private JSON atomically', async () => {
  const value = { version: 1, entries: [{ entryId: 'e1', state: 'ready' }] };
  await saveOutbox({ outboxPath, value });
  assert.deepEqual(await loadOutbox({ outboxPath }), value);
  assert.equal((await fs.stat(outboxPath)).mode & 0o777, 0o600);
});

test('withOutboxLock rejects an overlapping run and removes its lock', async () => {
  let release;
  const first = withOutboxLock({ lockPath, task: async () => new Promise((resolve) => { release = resolve; }) });
  await assert.rejects(withOutboxLock({ lockPath, task: async () => {} }), /already running/);
  release();
  await first;
  assert.equal(await exists(lockPath), false);
});
```

- [ ] **Step 2: Run the focused test and verify red**

Run: `node test/outbox.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/outbox.js`.

- [ ] **Step 3: Implement the outbox module**

Implement this exact public contract:

```ts
type Outbox = { version: 1; entries: OutboxEntry[] };

function createEmptyOutbox(): Outbox;
function validateOutbox(value: unknown): Outbox;
function loadOutbox(options: { outboxPath: string; fileSystem?: typeof fs }): Promise<Outbox>;
function saveOutbox(options: { outboxPath: string; value: Outbox; fileSystem?: typeof fs; processId?: number }): Promise<void>;
function withOutboxLock<T>(options: { lockPath: string; task: () => Promise<T>; fileSystem?: typeof fs }): Promise<T>;
```

`loadOutbox` returns `{ version: 1, entries: [] }` only for `ENOENT`. `saveOutbox` validates before writing, creates `<outboxPath>.tmp-<pid>` with `flag: "wx"` and mode `0600`, renames it, chmods the destination to `0600`, and removes the temporary path in `finally`. `withOutboxLock` opens the lock with `flag: "wx"` and mode `0600`, maps `EEXIST` to a sanitized already-running error, awaits `task`, and removes the lock in `finally`.

Validation permits `preopen_pending`, `capture_pending`, `timestamp_pending`, and `ready`; requires `entryId`, `state`, `leadName`, `conversationUrl`, and state-specific fields; and rejects unknown top-level versions and unknown entry fields. New `capture_pending` entries require `recoveryMode: direct`; legacy mode-less capture markers remain readable so capture startup can atomically migrate them to direct recovery. Error messages contain no entry data.

Add these gitignore entries:

```gitignore
.linkedin-unread-outbox.json
.linkedin-unread-outbox.json.tmp-*
.linkedin-unread-outbox.lock
.linkedin-timestamp-work.json
.linkedin-timestamp-work.json.tmp-*
.linkedin-timestamp-results.json
.linkedin-timestamp-results.json.tmp-*
```

- [ ] **Step 4: Run outbox tests and commit**

Run: `node test/outbox.test.js`

Expected: PASS.

```bash
git add linkedin-unread-reporter/src/outbox.js linkedin-unread-reporter/test/outbox.test.js linkedin-unread-reporter/.gitignore
git commit -m "feat: add private durable ingestion outbox"
```

### Task 4: Message normalization and idempotency

**Files:**
- Create: `linkedin-unread-reporter/src/messages.js`
- Create: `linkedin-unread-reporter/test/messages.test.js`

- [ ] **Step 1: Write failing domain tests**

```js
test('validateConversationUrl accepts only LinkedIn thread URLs', () => {
  assert.equal(
    validateConversationUrl('/messaging/thread/opaque-id/?filter=unread'),
    'https://www.linkedin.com/messaging/thread/opaque-id/',
  );
  assert.throws(() => validateConversationUrl('https://evil.example/thread/opaque-id'));
});

test('selectUnreadInboundMessages applies boundary, count, then newest fallback', () => {
  const messages = [
    { direction: 'outbound', content: 'old' },
    { direction: 'inbound', content: 'first' },
    { direction: 'inbound', content: 'second' },
  ];
  assert.deepEqual(selectUnreadInboundMessages({ messages, unreadBoundaryIndex: 1 }).map((x) => x.content), ['first', 'second']);
  assert.deepEqual(selectUnreadInboundMessages({ messages, expectedUnreadCount: 2 }).map((x) => x.content), ['first', 'second']);
  assert.deepEqual(selectUnreadInboundMessages({ messages }).map((x) => x.content), ['second']);
});

test('createIdempotencyKey prefers message id and otherwise hashes canonical fallback', () => {
  assert.equal(createIdempotencyKey({ linkedinMessageId: 'm-1' }), 'linkedin:m-1');
  assert.equal(createIdempotencyKey(fallbackInput), createIdempotencyKey({ ...fallbackInput, leadName: '  Ada   Lovelace ' }));
});
```

- [ ] **Step 2: Run the focused test and verify red**

Run: `node test/messages.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/messages.js`.

- [ ] **Step 3: Implement the pure message functions**

Implement these algorithms and exports:

```js
import { createHash } from 'node:crypto';

export function normalizeLeadName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function normalizeVisibleText(value) {
  return String(value || '').replace(/\r\n?/g, '\n').trim();
}

export function validateConversationUrl(value) {
  const url = new URL(String(value), 'https://www.linkedin.com');
  if (url.protocol !== 'https:' || url.hostname !== 'www.linkedin.com'
    || !/^\/messaging\/thread\/[^/]+\/$/.test(url.pathname)) {
    throw new MessageDataError('conversation-url-invalid');
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function selectUnreadInboundMessages({ messages, unreadBoundaryIndex, expectedUnreadCount }) {
  const inbound = messages.map((message, index) => ({ message, index }))
    .filter(({ message }) => message.direction === 'inbound');
  if (Number.isInteger(unreadBoundaryIndex)) {
    return inbound.filter(({ index }) => index >= unreadBoundaryIndex).map(({ message }) => message);
  }
  if (Number.isInteger(expectedUnreadCount) && expectedUnreadCount > 0) {
    return inbound.slice(-expectedUnreadCount).map(({ message }) => message);
  }
  return inbound.length ? [inbound.at(-1).message] : [];
}

export function createIdempotencyKey({ linkedinMessageId, leadName, sentAt, conversationUrl }) {
  if (linkedinMessageId) return `linkedin:${String(linkedinMessageId).trim()}`;
  const canonical = JSON.stringify([
    normalizeLeadName(leadName),
    new Date(sentAt).toISOString(),
    validateConversationUrl(conversationUrl),
  ]);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}
```

Reject empty names, invalid directions, missing visible content labels, invalid ISO timestamps, and invalid conversation URLs with sanitized `MessageDataError` codes.

- [ ] **Step 4: Run domain tests and commit**

Run: `node test/messages.test.js`

Expected: PASS.

```bash
git add linkedin-unread-reporter/src/messages.js linkedin-unread-reporter/test/messages.test.js
git commit -m "feat: normalize captured LinkedIn messages"
```

### Task 5: Unread candidate discovery and safe thread opening

**Files:**
- Modify: `linkedin-unread-reporter/src/browser.js`
- Modify: `linkedin-unread-reporter/test/browser-fixture.test.js`
- Create: `linkedin-unread-reporter/fixtures/unread-candidates.html`

- [ ] **Step 1: Add failing candidate fixtures**

Create a sanitized list fixture containing a one-to-one unread row with an anchor and count, an anchorless one-to-one row, a group row, a Sponsored row, and an automated row. Add tests:

```js
test('readUnreadCandidates returns eligible humans with URL and count metadata only', async () => {
  const candidates = await adapter.readUnreadCandidates({ limit: 50 });
  assert.deepEqual(candidates, [
    { rowId: 'human-1', leadName: 'Ada', unreadCount: 2, conversationUrl: 'https://www.linkedin.com/messaging/thread/thread-1/' },
    { rowId: 'human-2', leadName: 'Grace', unreadCount: null, conversationUrl: null },
  ]);
});

test('openConversation navigates by validated URL and clicks only the exact row as fallback', async () => {
  await adapter.openConversation(candidates[0]);
  assert.equal(page.url(), 'https://www.linkedin.com/messaging/thread/thread-1/');
  await adapter.gotoUnread(unreadUrl);
  await adapter.openConversation(candidates[1]);
  assert.match(page.url(), /\/messaging\/thread\/thread-2\/$/);
});
```

Assert no preview or message content is returned by candidate discovery and no group/Sponsored/automated row is opened.

- [ ] **Step 2: Run the browser fixture test and verify red**

Run: `node test/browser-fixture.test.js`

Expected: FAIL because `readUnreadCandidates` and `openConversation` do not exist.

- [ ] **Step 3: Implement candidate methods**

Add adapter methods:

```js
async readUnreadCandidates({ limit = 50, excludeRowIds = [] } = {})
async openConversation({ rowId, conversationUrl })
```

`readUnreadCandidates` remains scoped to the one uniquely visible conversation list, requires explicit unread state and stable row ID, extracts a numeric unread count only from an exact unread-count label, validates anchors with `validateConversationUrl`, and excludes explicit group/Sponsored/automated labels.

`openConversation` prefers `page.goto(conversationUrl)`. Without a URL, it resolves exactly one row by escaped stable ID, asserts the target is visible and still unread, clicks only that row, waits for a thread container, and validates `page.url()`. Never use a page-global click locator.

- [ ] **Step 4: Run browser fixtures and commit**

Run: `node test/browser-fixture.test.js`

Expected: PASS.

```bash
git add linkedin-unread-reporter/src/browser.js linkedin-unread-reporter/test/browser-fixture.test.js linkedin-unread-reporter/fixtures/unread-candidates.html
git commit -m "feat: discover and open unread LinkedIn threads"
```

### Task 6: Thread-message extraction

**Files:**
- Modify: `linkedin-unread-reporter/src/browser.js`
- Modify: `linkedin-unread-reporter/test/browser-fixture.test.js`
- Create: `linkedin-unread-reporter/fixtures/unread-thread.html`
- Create: `linkedin-unread-reporter/fixtures/unread-thread-no-boundary.html`

- [ ] **Step 1: Add failing thread extraction fixtures**

Fixtures must contain inbound and outbound text, an unread divider, exact `<time datetime>`, relative time, an image label, hidden stale messages, and no clickable attachment action. Tests assert:

```js
test('readThreadMessages extracts visible direction, content type, id, and time metadata', async () => {
  const snapshot = await adapter.readThreadMessages();
  assert.equal(snapshot.unreadBoundaryIndex, 2);
  assert.deepEqual(snapshot.messages[2], {
    linkedinMessageId: 'message-3',
    direction: 'inbound',
    contentType: 'text',
    content: 'Hello\nfrom LinkedIn 👋',
    sentAt: '2026-08-19T02:05:00.000Z',
    sentAtRaw: '11:35am',
  });
});

test('thread extraction records visible non-text labels without following links', async () => {
  const snapshot = await adapter.readThreadMessages();
  assert.deepEqual(snapshot.messages.at(-1).contentType, 'image');
  assert.equal(snapshot.messages.at(-1).content, 'Image attachment');
  assert.equal(downloadCalls, 0);
});
```

- [ ] **Step 2: Run fixtures and verify red**

Run: `node test/browser-fixture.test.js`

Expected: FAIL because `readThreadMessages` does not exist.

- [ ] **Step 3: Implement thread extraction**

Add:

```js
async readThreadMessages() {
  // Require exactly one visible thread container.
  // Return { conversationUrl, unreadBoundaryIndex, messages }.
  // Each message has linkedinMessageId|null, direction, contentType,
  // normalized visible content, sentAt|null, and sentAtRaw.
}
```

Direction must come from explicit inbound/outbound DOM state, not sender-name comparison. Fail closed on ambiguous direction, multiple visible thread containers, missing content/type, or invalid post-open URL. Prefer `datetime`, then exact `title`/`aria-label`; leave relative labels unresolved. Tooltip inspection may hover only the timestamp element and must never click a message or link.

- [ ] **Step 4: Run fixtures and commit**

Run: `node test/browser-fixture.test.js`

Expected: PASS.

```bash
git add linkedin-unread-reporter/src/browser.js linkedin-unread-reporter/test/browser-fixture.test.js linkedin-unread-reporter/fixtures/unread-thread.html linkedin-unread-reporter/fixtures/unread-thread-no-boundary.html
git commit -m "feat: extract unread LinkedIn thread messages"
```

### Task 7: Capture orchestration and recovery markers

**Files:**
- Replace: `linkedin-unread-reporter/src/scanner.js`
- Replace: `linkedin-unread-reporter/test/scanner.test.js`

- [ ] **Step 1: Write failing capture workflow tests**

Use a stateful fake adapter and real outbox callbacks:

```js
test('captureUnreadMessages checkpoints each conversation before opening the next', async () => {
  const events = [];
  const result = await captureUnreadMessages({
    adapter,
    outbox: createEmptyOutbox(),
    saveOutbox: async (value) => events.push(['save', structuredClone(value)]),
    scanStartedAt: new Date('2026-08-19T03:00:00.000Z'),
    cap: 50,
  });
  assert.deepEqual(events.map(([type]) => type), ['save', 'save']);
  assert.equal(result.processedConversations, 2);
  assert.equal(result.capturedMessages, 3);
});

test('captureUnreadMessages retries direct URL three times then persists capture_pending', async () => {
  adapter.readThreadMessages = async () => { throw new Error('fixture extraction failure'); };
  const result = await captureUnreadMessages(options);
  assert.equal(adapter.openCalls, 3);
  assert.equal(result.outbox.entries[0].state, 'capture_pending');
  assert.equal(result.outbox.entries[0].expectedUnreadCount, 2);
});
```

Also test boundary/count/newest selection, exact timestamps becoming `ready`, relative timestamps becoming `timestamp_pending`, recovery markers before new rows, list refresh after every thread, and the 50-conversation cap.

- [ ] **Step 2: Run scanner tests and verify red**

Run: `node test/scanner.test.js`

Expected: FAIL because `captureUnreadMessages` is not exported.

- [ ] **Step 3: Implement `captureUnreadMessages`**

Export one orchestration function with this contract:

```ts
function captureUnreadMessages(options: {
  adapter: LinkedInAdapter;
  outbox: Outbox;
  saveOutbox: (value: Outbox) => Promise<void>;
  unreadUrl: string;
  scanStartedAt: Date;
  cap?: number;
  authTimeoutMs?: number;
}): Promise<{
  outbox: Outbox;
  processedConversations: number;
  capturedMessages: number;
  pendingRecovery: number;
  pendingTimestamps: number;
  truncated: boolean;
}>;
```

Process `capture_pending` entries first through direct URL recovery. For each new row with a validated destination, persist `preopen_pending` while stabilizing metadata; perform final list-and-exact-candidate revalidation as the last observation; atomically replace it with `capture_pending` and `recoveryMode: direct`; then immediately invoke navigation without another await. A promotion failure before commit leaves `preopen_pending`, does not open, and is discarded at next startup. A failure or abort observed after rename may leave durable direct intent while still preventing the current open, so the next run direct-recovers it at least once. A crash following a successful promotion is handled identically. For a truly anchorless row, accept the clicked result only when the same uniquely visible list identifies that stable row as its sole active row; recover visible blockers by returning to unread and re-resolving the still-unread row. Persist `capture_pending/direct` in `onOpened` before thread readiness or extraction. If the list correlation is unavailable, fail closed with no marker; a narrow unavoidable click-to-marker crash window remains. On successful extraction atomically replace that marker with one message entry per selected inbound message. Refresh the direct unread URL after every conversation and never retain a Playwright row handle.

This deliberately chooses at-least-once durability because LinkedIn navigation and the local outbox cannot be atomic across two systems. The marker reflects the last verified eligibility observation. A narrow external-state race and duplicate capture remain possible, but Portal idempotency keys mitigate duplicates; avoiding message loss takes priority.

Return count-only metadata: `processedConversations`, `capturedMessages`, `pendingRecovery`, `pendingTimestamps`, and `truncated`.

- [ ] **Step 4: Run scanner tests and commit**

Run: `node test/scanner.test.js`

Expected: PASS.

```bash
git add linkedin-unread-reporter/src/scanner.js linkedin-unread-reporter/test/scanner.test.js
git commit -m "feat: checkpoint captured LinkedIn messages"
```

### Task 8: Timestamp normalization and subagent bridge

**Files:**
- Create: `linkedin-unread-reporter/src/timestamps.js`
- Create: `linkedin-unread-reporter/test/timestamps.test.js`

- [ ] **Step 1: Write failing timestamp tests**

```js
test('buildTimestampWork exposes only temporary keys, labels, and scan anchors', () => {
  const work = buildTimestampWork(outbox, { attempt: 1 });
  assert.deepEqual(work.items[0], {
    itemKey: 'entry-1',
    relativeTime: '2h',
    scanStartedAt: '2026-08-19T03:00:00.000Z',
  });
  assert.doesNotMatch(JSON.stringify(work), /Ada|Hello|messaging\/thread/);
});

test('applyTimestampResults promotes valid entries and rejects malformed output', () => {
  const next = applyTimestampResults(outbox, {
    version: 1,
    items: [{ itemKey: 'entry-1', sentAt: '2026-08-19T01:00:00.000Z' }],
  });
  assert.equal(next.entries[0].state, 'ready');
  assert.equal(next.entries[0].sentAtAccuracy, 'estimated');
  assert.throws(() => applyTimestampResults(outbox, { version: 1, items: [] }));
});

test('convertRelativeTime uses the fixed anchor deterministically', () => {
  assert.equal(convertRelativeTime('2h', '2026-08-19T03:00:00.000Z'), '2026-08-19T01:00:00.000Z');
});
```

Test `now`, minutes, hours, days, weeks, `yesterday`, atomic `0600` work/result sidecars, result polling timeout, three invalid attempts, and local fallback after attempt three.

- [ ] **Step 2: Run timestamp tests and verify red**

Run: `node test/timestamps.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/timestamps.js`.

- [ ] **Step 3: Implement the timestamp module**

Export:

```js
export function buildTimestampWork(outbox, { attempt })
export async function writeTimestampWork({ workPath, work, fileSystem = fs, processId = process.pid })
export async function waitForTimestampResults({ resultPath, timeoutMs, pollIntervalMs = 1_000, fileSystem = fs })
export function applyTimestampResults(outbox, result)
export function convertRelativeTime(relativeTime, scanStartedAt)
export function applyLocalTimestampFallback(outbox)
export async function removeTimestampSidecars({ workPath, resultPath, fileSystem = fs })
```

Work files contain only `{ version, attempt, items: [{ itemKey, relativeTime, scanStartedAt }] }`. Result files contain only `{ version, items: [{ itemKey, sentAt }] }`. Validate exact item coverage and ISO timestamps. After three invalid/timeout attempts, apply local parsing; unsupported labels remain `timestamp_pending` and make the workflow fail count-only without portal delivery.

- [ ] **Step 4: Run timestamp tests and commit**

Run: `node test/timestamps.test.js`

Expected: PASS.

```bash
git add linkedin-unread-reporter/src/timestamps.js linkedin-unread-reporter/test/timestamps.test.js
git commit -m "feat: normalize relative LinkedIn timestamps"
```

### Task 9: Portal batch delivery and acknowledgement policy

**Files:**
- Create: `linkedin-unread-reporter/src/portal.js`
- Create: `linkedin-unread-reporter/test/portal.test.js`

- [ ] **Step 1: Write failing portal tests**

```js
test('postPortalBatch sends one authenticated versioned batch', async () => {
  await postPortalBatch({
    webhookUrl: 'https://portal.example.test/hooks/linkedin',
    callSecret: 'private-call-secret',
    messages: readyMessages,
    capturedAt: new Date('2026-08-19T03:00:00.000Z'),
    fetchImpl,
  });
  assert.equal(request.headers['X-Portal-Call-Secret'], 'private-call-secret');
  assert.equal(JSON.parse(request.body).messages[0].status, undefined);
});

test('deliverReadyEntries removes created, duplicate, and missing 2xx results', async () => {
  const result = await deliverReadyEntries({ outbox, postBatch: async () => ({
    results: [{ idempotencyKey: 'created-key', status: 'created' }],
  }) });
  assert.deepEqual(result.outbox.entries, []);
  assert.deepEqual(result.counts, { created: 1, duplicate: 0, assumedDuplicate: 1 });
});
```

Test network errors, timeouts, non-2xx status categories, malformed 2xx JSON treated as all duplicates, secret redaction, one batch only, and no message fields in error text.

- [ ] **Step 2: Run portal tests and verify red**

Run: `node test/portal.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/portal.js`.

- [ ] **Step 3: Implement portal delivery**

Export:

```js
export async function postPortalBatch({ webhookUrl, callSecret, messages, capturedAt, fetchImpl = globalThis.fetch, timeoutMs = 15_000 })
export async function deliverReadyEntries({ outbox, postBatch, capturedAt })
```

Generate `batchId` with `crypto.randomUUID()`, send `content-type: application/json` and `X-Portal-Call-Secret`, and return only sanitized acknowledgement data. For network/non-2xx failures throw `PortalDeliveryError` and leave the caller's outbox unchanged. For any 2xx response, remove every submitted ready entry; count explicit `created`/`duplicate`, and classify missing, malformed, or unknown results as `assumedDuplicate` per the approved product decision.

- [ ] **Step 4: Run portal tests and commit**

Run: `node test/portal.test.js`

Expected: PASS.

```bash
git add linkedin-unread-reporter/src/portal.js linkedin-unread-reporter/test/portal.test.js
git commit -m "feat: deliver idempotent portal batches"
```

### Task 10: Lock-holding end-to-end workflow

**Files:**
- Create: `linkedin-unread-reporter/src/workflow.js`
- Create: `linkedin-unread-reporter/test/workflow.test.js`

- [ ] **Step 1: Write failing workflow-order tests**

```js
test('workflow drains ready records before opening LinkedIn', async () => {
  const events = [];
  await runPortalWorkflow({
    ...dependencies,
    deliver: async () => { events.push('deliver-existing'); return emptyDelivery; },
    capture: async () => { events.push('capture'); return captureResult; },
  });
  assert.deepEqual(events.slice(0, 2), ['deliver-existing', 'capture']);
});

test('workflow stops before browser capture when initial delivery fails', async () => {
  let browserOpened = false;
  await assert.rejects(runPortalWorkflow({
    ...dependencies,
    deliver: async () => { throw new PortalDeliveryError('Portal delivery failed (5xx).'); },
    capture: async () => { browserOpened = true; },
  }));
  assert.equal(browserOpened, false);
});
```

Also assert the lock spans initial delivery, browser recovery/capture, three timestamp-result waits, local fallback, final delivery, and final outbox save; count-only results expose no message data.

- [ ] **Step 2: Run workflow tests and verify red**

Run: `node test/workflow.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/workflow.js`.

- [ ] **Step 3: Implement `runPortalWorkflow`**

Implement this contract:

```ts
function runPortalWorkflow(options: {
  config: ReporterConfig;
  captureNew?: boolean;
  withLock?: typeof withOutboxLock;
  load?: typeof loadOutbox;
  save?: typeof saveOutbox;
  deliver?: typeof deliverReadyEntries;
  capture: typeof captureUnreadMessages;
  writeWork?: typeof writeTimestampWork;
  waitForResults?: typeof waitForTimestampResults;
  notifyTimestampWork?: (event: { count: number; attempt: number }) => void;
  now?: () => Date;
}): Promise<WorkflowCounts>;
```

Inside one `withLock` callback, execute the specification's nine stages in order. Save after every delivery, recovery, capture, timestamp application, fallback, and final acknowledgement transition; never return an in-memory outbox state that was not persisted.

For each timestamp attempt, write the sanitized work sidecar, emit only `Timestamp normalization required: N item(s), attempt X of 3.`, wait for the private result sidecar, validate/apply/save, and remove sidecars. After attempt three, apply and save deterministic fallback. If unsupported records remain, throw a sanitized count-only workflow error and retain them.

Return:

```js
{
  processedConversations,
  capturedMessages,
  created,
  duplicate,
  assumedDuplicate,
  pendingRecovery,
  pendingTimestamps,
}
```

- [ ] **Step 4: Run workflow tests and commit**

Run: `node test/workflow.test.js`

Expected: PASS.

```bash
git add linkedin-unread-reporter/src/workflow.js linkedin-unread-reporter/test/workflow.test.js
git commit -m "feat: orchestrate durable portal ingestion"
```

### Task 11: CLI migration and Slack removal

**Files:**
- Modify: `linkedin-unread-reporter/src/cli.js`
- Modify: `linkedin-unread-reporter/test/cli.test.js`
- Modify: `linkedin-unread-reporter/package.json`
- Delete: `linkedin-unread-reporter/src/report.js`
- Delete: `linkedin-unread-reporter/src/slack.js`
- Delete: `linkedin-unread-reporter/test/report.test.js`
- Delete: `linkedin-unread-reporter/test/slack.test.js`

- [ ] **Step 1: Write failing CLI tests for the new commands**

Require this interface:

```text
node src/cli.js <configure|login|scan|deliver|scheduled-report>
```

Tests must prove:

```js
test('scan captures to the outbox without portal delivery', async () => {
  assert.equal(await runCli(['scan'], dependencies), 0);
  assert.equal(captureCalls, 1);
  assert.equal(deliveryCalls, 0);
  assert.match(stdout.join('\n'), /Captured: 3 messages from 2 conversations/);
  assert.doesNotMatch(stdout.join('\n'), /Ada|Hello|messaging\/thread/);
});

test('scheduled-report runs the complete workflow and prints counts only', async () => {
  assert.equal(await runCli(['scheduled-report'], dependencies), 0);
  assert.match(stdout.join('\n'), /Created: 2.*Duplicates: 1/);
  assert.doesNotMatch(stdout.join('\n'), /leadName|content|conversationUrl/);
});
```

Remove `slack-test` acceptance and assert it returns usage without side effects.

- [ ] **Step 2: Run CLI tests and verify red**

Run: `node test/cli.test.js`

Expected: FAIL because portal commands and dependencies are absent.

- [ ] **Step 3: Implement CLI and package scripts**

Replace Slack dependencies with `configurePortal`, `captureUnreadMessages`, and `runPortalWorkflow`. `scan` uses `requirePortal: false`, captures and checkpoints but never calls the portal. `deliver` runs `runPortalWorkflow({ captureNew: false })`. `scheduled-report` runs the full workflow. All commands redact configured portal secrets and print aggregate counts only.

Use scripts:

```json
{
  "configure": "node src/cli.js configure",
  "login": "node src/cli.js login",
  "scan": "node src/cli.js scan",
  "deliver": "node src/cli.js deliver",
  "report": "node src/cli.js scheduled-report"
}
```

Delete Slack source/tests only after the new CLI and portal tests pass.

- [ ] **Step 4: Run CLI and complete tests, then commit**

Run: `node test/cli.test.js`

Run: `npm test`

Expected: PASS with no Slack runtime imports.

```bash
git add linkedin-unread-reporter/src/cli.js linkedin-unread-reporter/test/cli.test.js linkedin-unread-reporter/package.json linkedin-unread-reporter/package-lock.json
git add -u linkedin-unread-reporter/src/report.js linkedin-unread-reporter/src/slack.js linkedin-unread-reporter/test/report.test.js linkedin-unread-reporter/test/slack.test.js
git commit -m "feat: replace Slack reports with portal ingestion"
```

### Task 12: Skill setup and timestamp-subagent automation protocol

**Files:**
- Modify: `linkedin-unread-reporter/SKILL.md`
- Modify: `linkedin-unread-reporter/references/automation-setup.md`
- Modify: `README.md`
- Modify: `linkedin-unread-reporter/agents/openai.yaml`
- Modify: `linkedin-unread-reporter/test/plugin.test.js`

- [ ] **Step 1: Write failing skill packaging assertions**

Assert the installed skill:

- asks for Portal Webhook URL and `PORTAL_CALL_SECRET`, never Slack;
- requires HTTPS and `.env` mode `0600`;
- documents read-on-open and the private outbox;
- invokes `npm run scan`, obtains approval, then invokes `npm run deliver` for the first real portal batch;
- keeps the three fixed Adelaide schedules with `gpt-5.6-sol` and medium reasoning;
- instructs the scheduled Codex task to monitor `npm run report`, dispatch one timestamp-only subagent each time the terminal requests attempt 1–3, and never pass names/content/URLs;
- preserves count-only task output; and
- contains no Slack runtime prompt.

Use meaningful assertions such as:

```js
assert.match(skill, /PORTAL_WEBHOOK_URL/);
assert.match(skill, /PORTAL_CALL_SECRET/);
assert.doesNotMatch(skill, /npm run slack-test/);
assert.match(automation, /timestamp-only subagent/i);
assert.match(automation, /attempt 1 of 3/i);
```

- [ ] **Step 2: Run packaging tests and verify red**

Run: `node test/plugin.test.js`

Expected: FAIL because the current skill is Slack-oriented and forbids opening rows.

- [ ] **Step 3: Rewrite the skill workflow and automation prompt**

Update the top-level safety boundary from “never open a conversation” to:

- open only an explicitly eligible unread one-to-one thread;
- never send/edit a LinkedIn message or follow/download an attachment;
- checkpoint immediately after extraction;
- keep all sensitive output count-only.

The scheduled automation prompt must run `npm run report` in a persistent terminal session. When it prints `Timestamp normalization required: N item(s), attempt X of 3.`, Codex dispatches exactly one subagent whose task is:

```text
Work only in the installed linkedin-unread-reporter skill directory. Read the private
.linkedin-timestamp-work.json file. It contains only temporary item keys, relative
time labels, and scanStartedAt. Convert every item to an ISO-8601 sentAt value using
the supplied anchor. Atomically write mode-0600 .linkedin-timestamp-results.json as
{"version":1,"items":[{"itemKey":"entry-1","sentAt":"2026-08-19T01:00:00.000Z"}]}. Do not read the
outbox, browser profile, .env, lead names, message content, or LinkedIn URLs. Return
only the number of converted items.
```

The parent monitors the same process, dispatches at most one subagent for each of attempts 1–3, and lets the reporter use local fallback after attempt three. No timestamp values enter the final Codex task output.

- [ ] **Step 4: Validate docs and commit**

Run: `node test/plugin.test.js`

Run: `python3 /Users/haydnqi/.codex/skills/.system/skill-creator/scripts/quick_validate.py linkedin-unread-reporter`

Expected: PASS.

```bash
git add linkedin-unread-reporter/SKILL.md linkedin-unread-reporter/references/automation-setup.md README.md linkedin-unread-reporter/agents/openai.yaml linkedin-unread-reporter/test/plugin.test.js
git commit -m "docs: define portal ingestion skill workflow"
```

### Task 13: End-to-end regression and privacy verification

**Files:**
- Create: `linkedin-unread-reporter/test/portal-workflow-fixture.test.js`
- Modify: `linkedin-unread-reporter/test/run-tests.js` only if deterministic ordering or environment setup is required.

- [ ] **Step 1: Add a sanitized full-workflow fixture test**

Exercise real browser fixtures plus real outbox/timestamp/portal modules with injected fetch and filesystem paths:

```js
test('full workflow captures, checkpoints, normalizes, deduplicates, and clears outbox', async () => {
  const result = await runPortalWorkflow(fixtureDependencies);
  assert.deepEqual(result, {
    processedConversations: 2,
    capturedMessages: 3,
    created: 2,
    duplicate: 1,
    assumedDuplicate: 0,
    pendingRecovery: 0,
    pendingTimestamps: 0,
  });
  assert.deepEqual((await loadOutbox({ outboxPath })).entries, []);
  assert.doesNotMatch(logs.join('\n'), /Ada|Hello|messaging\/thread|private-call-secret/);
});
```

Add a restart case that fails after opening the first thread, loads the persisted recovery marker in a second workflow run, extracts via the thread URL, and delivers exactly once.

- [ ] **Step 2: Run the end-to-end test and correct only implementation defects**

Run: `node test/portal-workflow-fixture.test.js`

Expected: PASS.

- [ ] **Step 3: Run complete verification**

Run: `npm run check`

Run: `python3 /Users/haydnqi/.codex/skills/.system/skill-creator/scripts/quick_validate.py linkedin-unread-reporter`

Run: `git diff --check`

Expected: all syntax checks, unit tests, browser fixtures, workflow tests, packaging tests, and skill validation pass with no whitespace errors.

- [ ] **Step 4: Review the final diff and commit**

Confirm the two pre-existing deleted 2026-08-14 documents remain outside the feature commits unless the user separately authorizes their deletion. Confirm no `.env`, outbox, timestamp sidecar, lock, browser profile, portal secret, message content, or machine-specific home path is tracked.

```bash
git add linkedin-unread-reporter/test/portal-workflow-fixture.test.js linkedin-unread-reporter/test/run-tests.js
git commit -m "test: verify portal ingestion workflow end to end"
```
