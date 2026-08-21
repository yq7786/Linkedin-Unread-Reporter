import assert from 'node:assert/strict';
import test from 'node:test';

import { PortalDeliveryError } from '../src/portal.js';
import { runPortalWorkflow } from '../src/workflow.js';

const config = {
  outboxPath: '/private/outbox.json',
  outboxLockPath: '/private/outbox.lock',
  timestampWorkPath: '/private/timestamp-work.json',
  timestampResultPath: '/private/timestamp-results.json',
  unreadUrl: 'https://www.linkedin.com/messaging/?filter=unread',
  maxUnreadConversations: 50,
  authTimeoutMs: 10,
  portalWebhookUrl: 'https://portal.example.test/hooks/linkedin',
  portalCallSecret: 'private-call-secret',
};
const workId = '11111111-1111-4111-8111-111111111111';

const emptyOutbox = () => ({ version: 1, entries: [] });
const emptyDelivery = (outbox) => {
  const readyCount = outbox.entries.filter(({ state }) => state === 'ready').length;
  return {
    outbox: {
      version: 1,
      entries: outbox.entries.filter(({ state }) => state !== 'ready'),
    },
    counts: { created: 0, duplicate: 0, assumedDuplicate: readyCount },
  };
};

const readyEntry = (entryId = 'ready-1') => ({
  entryId,
  state: 'ready',
  leadName: 'Private Lead',
  conversationUrl: `https://www.linkedin.com/messaging/thread/${entryId}/`,
  idempotencyKey: `linkedin:${entryId}`,
  linkedinMessageId: entryId,
  contentType: 'text',
  content: 'Private content',
  sentAt: '2026-08-19T02:00:00.000Z',
  sentAtRaw: '1h',
  sentAtAccuracy: 'exact',
});

const timestampEntry = (entryId = 'timestamp-1') => ({
  entryId,
  state: 'timestamp_pending',
  leadName: 'Private Lead',
  conversationUrl: `https://www.linkedin.com/messaging/thread/${entryId}/`,
  linkedinMessageId: entryId,
  contentType: 'text',
  content: 'Private content',
  sentAtRaw: '2h',
  scanStartedAt: '2026-08-19T03:00:00.000Z',
});

function dependencies(overrides = {}) {
  let durable = overrides.initialOutbox ?? emptyOutbox();
  const saved = [];
  return {
    saved,
    options: {
      config,
      withLock: async ({ task }) => task({ signal: new AbortController().signal }),
      load: async () => structuredClone(durable),
      save: async ({ value }) => {
        durable = structuredClone(value);
        saved.push(structuredClone(value));
      },
      deliver: async ({ outbox }) => emptyDelivery(outbox),
      capture: async ({ outbox }) => ({
        outbox,
        processedConversations: 0,
        capturedMessages: 0,
        pendingRecovery: 0,
        pendingTimestamps: 0,
      }),
      writeWork: async () => {},
      readWork: async () => null,
      readResults: async () => null,
      removeSidecars: async () => {},
      removeResult: async () => {},
      generateTimestampWorkId: () => workId,
      now: () => new Date('2026-08-19T03:00:00.000Z'),
      ...overrides,
    },
  };
}

test('workflow drains ready records before opening LinkedIn and returns counts only', async () => {
  const events = [];
  const { options } = dependencies({
    initialOutbox: { version: 1, entries: [readyEntry()] },
    deliver: async ({ outbox }) => {
      events.push('deliver-existing');
      return emptyDelivery(outbox);
    },
    capture: async ({ outbox, captureNew }) => {
      events.push('capture');
      return {
        outbox,
        processedConversations: captureNew ? 2 : 0,
        capturedMessages: captureNew ? 3 : 0,
        pendingRecovery: 0,
        pendingTimestamps: 0,
      };
    },
  });

  const result = await runPortalWorkflow(options);

  assert.deepEqual(events.slice(0, 2), ['deliver-existing', 'capture']);
  assert.deepEqual(result, {
    processedConversations: 2,
    capturedMessages: 3,
    created: 0,
    duplicate: 0,
    assumedDuplicate: 1,
    pendingRecovery: 0,
    pendingTimestamps: 0,
  });
  assert.deepEqual(Object.keys(result).sort(), [
    'assumedDuplicate', 'capturedMessages', 'created', 'duplicate',
    'pendingRecovery', 'pendingTimestamps', 'processedConversations',
  ]);
});

test('workflow stops before browser capture when initial delivery fails', async () => {
  let browserOpened = false;
  const { options, saved } = dependencies({
    initialOutbox: { version: 1, entries: [readyEntry()] },
    deliver: async () => { throw new PortalDeliveryError('Portal delivery failed (5xx).'); },
    capture: async () => { browserOpened = true; },
  });

  await assert.rejects(runPortalWorkflow(options), PortalDeliveryError);
  assert.equal(browserOpened, false);
  assert.equal(saved.length, 0);
});

test('workflow converts parseable relative labels immediately without waiting', async () => {
  const events = [];
  const { options, saved } = dependencies({
    initialOutbox: { version: 1, entries: [timestampEntry()] },
    captureNew: false,
    writeWork: async () => events.push('write'),
    readResults: async () => { events.push('read'); return null; },
    notifyTimestampWork: () => events.push('notify'),
    removeSidecars: async () => events.push('cleanup'),
  });

  const result = await runPortalWorkflow(options);

  assert.deepEqual(events, ['cleanup']);
  assert.equal(saved.some(({ entries }) => entries[0]?.state === 'ready'), true);
  assert.equal(saved.find(({ entries }) => entries[0]?.state === 'ready').entries[0].sentAt, '2026-08-19T01:00:00.000Z');
  assert.equal(result.pendingTimestamps, 0);
});

test('workflow applies an operating-agent result sidecar without polling', async () => {
  const events = [];
  const pending = {
    ...timestampEntry(),
    sentAtRaw: 'last Tuesday',
  };
  const { options, saved } = dependencies({
    initialOutbox: { version: 1, entries: [pending] },
    captureNew: false,
    writeWork: async ({ work }) => events.push(`write-${work.workId}`),
    notifyTimestampWork: (event) => events.push(`notify-${event.count}`),
    readResults: async ({ workId: expectedWorkId }) => {
      events.push('read');
      return {
        version: 1,
        workId: expectedWorkId,
        items: [{ itemKey: 'timestamp-1', sentAt: '2026-08-18T01:00:00.000Z' }],
      };
    },
    removeSidecars: async () => events.push('cleanup'),
  });

  const result = await runPortalWorkflow(options);

  assert.deepEqual(events, ['write-11111111-1111-4111-8111-111111111111', 'notify-1', 'read', 'cleanup']);
  assert.equal(saved.some(({ entries }) => entries[0]?.state === 'ready'), true);
  assert.equal(result.pendingTimestamps, 0);
});

test('workflow preserves stale-result removal errors and cleans up before publishing', async () => {
  const primaryError = new Error('Timestamp stale result removal failed.');
  let writes = 0;
  let cleanups = 0;
  const { options } = dependencies({
    initialOutbox: { version: 1, entries: [{ ...timestampEntry(), sentAtRaw: 'last Tuesday' }] },
    captureNew: false,
    removeResult: async () => { throw primaryError; },
    writeWork: async () => { writes += 1; },
    removeSidecars: async () => {
      cleanups += 1;
      throw new Error('Timestamp sidecar cleanup failed.');
    },
  });

  await assert.rejects(runPortalWorkflow(options), (error) => error === primaryError);
  assert.equal(writes, 0);
  assert.equal(cleanups, 1);
});

test('unsupported leftover writes work once, keeps sidecars, and fails count-only before portal delivery', async () => {
  const privateValues = ['Private Lead', 'Private content', 'last Tuesday', 'private-thread'];
  const pending = {
    entryId: 'private-entry',
    state: 'timestamp_pending',
    leadName: privateValues[0],
    conversationUrl: `https://www.linkedin.com/messaging/thread/${privateValues[3]}/`,
    linkedinMessageId: null,
    contentType: 'text',
    content: privateValues[1],
    sentAtRaw: privateValues[2],
    scanStartedAt: '2026-08-19T03:00:00.000Z',
  };
  const events = [];
  const notifications = [];
  let deliveries = 0;
  const { options, saved } = dependencies({
    initialOutbox: { version: 1, entries: [pending] },
    captureNew: false,
    deliver: async ({ outbox }) => {
      deliveries += 1;
      return emptyDelivery(outbox);
    },
    writeWork: async ({ work }) => events.push(`write-${work.attempt}`),
    notifyTimestampWork: (event) => notifications.push(event),
    readResults: async () => { events.push('read'); return null; },
    removeSidecars: async () => events.push('cleanup'),
  });

  await assert.rejects(runPortalWorkflow(options), (error) => {
    assert.match(error.message, /1 timestamp item/);
    for (const value of privateValues) assert.doesNotMatch(error.message, new RegExp(value));
    return true;
  });
  assert.equal(deliveries, 0);
  assert.deepEqual(events, ['write-1', 'read']);
  assert.deepEqual(notifications, [{ count: 1 }]);
  assert.equal(saved.length, 0);
});

test('captureNew false never invokes browser capture', async () => {
  let captures = 0;
  const { options } = dependencies({
    captureNew: false,
    capture: async () => { captures += 1; },
  });
  await runPortalWorkflow(options);
  assert.equal(captures, 0);
});

test('a compromised lock aborts after an awaited portal operation before save or browser work', async () => {
  const controller = new AbortController();
  const compromise = new Error('Outbox lock failed.');
  let saves = 0;
  let captures = 0;
  const { options } = dependencies({
    initialOutbox: { version: 1, entries: [readyEntry()] },
    withLock: async ({ task }) => task({ signal: controller.signal }),
    deliver: async ({ outbox }) => {
      controller.abort(compromise);
      return emptyDelivery(outbox);
    },
    save: async () => { saves += 1; },
    capture: async () => { captures += 1; },
  });

  await assert.rejects(runPortalWorkflow(options), compromise);
  assert.equal(saves, 0);
  assert.equal(captures, 0);
});

test('a compromised lock stops immediately before the nested default portal call', async () => {
  const controller = new AbortController();
  const compromise = new Error('Outbox lock failed.');
  const { options } = dependencies({
    initialOutbox: { version: 1, entries: [readyEntry()] },
    config: { ...config, portalWebhookUrl: 'invalid-private-url' },
    withLock: async ({ task }) => task({ signal: controller.signal }),
    deliver: async ({ outbox, postBatch, capturedAt }) => {
      controller.abort(compromise);
      await postBatch({ messages: [], capturedAt });
      return emptyDelivery(outbox);
    },
  });

  await assert.rejects(runPortalWorkflow(options), compromise);
});

test('workflow requires an injected capture dependency even in delivery-only mode', async () => {
  const { options } = dependencies({ capture: undefined, captureNew: false });
  await assert.rejects(
    runPortalWorkflow(options),
    (error) => /capture dependency.*invalid/i.test(error.message),
  );
});

test('workflow runs delivery, recovery, existing timestamps, discovery, new timestamps, delivery in order', async () => {
  const events = [];
  const initial = { version: 1, entries: [readyEntry(), timestampEntry()] };
  const { options, saved } = dependencies({
    initialOutbox: initial,
    deliver: async ({ outbox }) => {
      events.push('deliver');
      return {
        outbox: { version: 1, entries: outbox.entries.filter(({ state }) => state !== 'ready') },
        counts: { created: 1, duplicate: 0, assumedDuplicate: 0 },
      };
    },
    capture: async ({ outbox, recoverPending, captureNew }) => {
      events.push(recoverPending ? 'recover' : 'discover');
      assert.notEqual(recoverPending, captureNew);
      return {
        outbox,
        processedConversations: recoverPending ? 1 : 2,
        capturedMessages: recoverPending ? 0 : 3,
        pendingRecovery: 0,
        pendingTimestamps: outbox.entries.filter(({ state }) => state === 'timestamp_pending').length,
        truncated: false,
      };
    },
    writeWork: async () => events.push('write'),
    readResults: async () => { events.push('read'); return null; },
    removeSidecars: async () => events.push('cleanup'),
  });

  const result = await runPortalWorkflow(options);

  assert.deepEqual(events, [
    'deliver', 'recover', 'cleanup', 'discover', 'deliver',
  ]);
  assert.equal(saved.length, 3);
  assert.deepEqual(result, {
    processedConversations: 3,
    capturedMessages: 3,
    created: 2,
    duplicate: 0,
    assumedDuplicate: 0,
    pendingRecovery: 0,
    pendingTimestamps: 0,
  });
});

test('workflow skips empty deliveries and saves only changed outboxes', async () => {
  let deliveryCalls = 0;
  const { options, saved } = dependencies({
    deliver: async () => { deliveryCalls += 1; },
  });

  await runPortalWorkflow(options);

  assert.equal(deliveryCalls, 0);
  assert.equal(saved.length, 0);
});

test('workflow isolates callback inputs and rejects malformed outputs without private values', async () => {
  const original = { version: 1, entries: [readyEntry()] };
  const privateValue = 'private-malformed-field';
  const { options } = dependencies({
    initialOutbox: original,
    deliver: async ({ outbox, capturedAt }) => {
      assert.throws(() => { outbox.entries.push(readyEntry('injected')); }, TypeError);
      capturedAt.setUTCFullYear(1999);
      return {
        outbox: { ...structuredClone(outbox), [privateValue]: true },
        counts: { created: Number.NaN, duplicate: 0, assumedDuplicate: 0 },
      };
    },
  });

  await assert.rejects(runPortalWorkflow(options), (error) => {
    assert.match(error.message, /workflow dependency.*invalid/i);
    assert.doesNotMatch(error.message, new RegExp(privateValue));
    return true;
  });
  assert.deepEqual(original, { version: 1, entries: [readyEntry()] });
});

test('workflow saves a valid timestamp transition before sidecar cleanup failure', async () => {
  const events = [];
  const cleanupError = new Error('Timestamp sidecar cleanup failed.');
  const { options, saved } = dependencies({
    initialOutbox: { version: 1, entries: [timestampEntry()] },
    captureNew: false,
    save: async ({ value }) => {
      events.push('save');
      saved.push(structuredClone(value));
    },
    removeSidecars: async () => {
      events.push('cleanup');
      throw cleanupError;
    },
  });

  await assert.rejects(runPortalWorkflow(options), cleanupError);
  assert.deepEqual(events, ['save', 'cleanup']);
  assert.equal(saved[0].entries[0].state, 'ready');
});

test('workflow does not retry a failed timestamp transition save', async () => {
  const saveError = new Error('Outbox save failed.');
  let reads = 0;
  let cleanups = 0;
  const { options } = dependencies({
    initialOutbox: { version: 1, entries: [timestampEntry()] },
    captureNew: false,
    save: async () => { throw saveError; },
    readResults: async () => { reads += 1; return null; },
    removeSidecars: async () => { cleanups += 1; },
  });

  await assert.rejects(runPortalWorkflow(options), (error) => error === saveError);
  assert.equal(reads, 0);
  assert.equal(cleanups, 1);
});

test('workflow gives lock compromise precedence when a portal operation rejects', async () => {
  const controller = new AbortController();
  const compromise = new Error('Outbox lock failed.');
  const operationError = new Error('private portal failure');
  let captures = 0;
  const { options } = dependencies({
    initialOutbox: { version: 1, entries: [readyEntry()] },
    withLock: async ({ task }) => task({ signal: controller.signal }),
    deliver: async () => {
      controller.abort(compromise);
      throw operationError;
    },
    capture: async () => { captures += 1; },
  });

  await assert.rejects(runPortalWorkflow(options), compromise);
  assert.equal(captures, 0);
});

test('workflow checks cancellation after now before deriving timestamp state', async () => {
  const controller = new AbortController();
  const compromise = new Error('Outbox lock failed.');
  let derived = false;
  const date = new Date('2026-08-19T03:00:00.000Z');
  date.valueOf = () => {
    derived = true;
    return Date.parse('2026-08-19T03:00:00.000Z');
  };
  const { options } = dependencies({
    withLock: async ({ task }) => task({ signal: controller.signal }),
    now: () => {
      controller.abort(compromise);
      return date;
    },
  });

  await assert.rejects(runPortalWorkflow(options), compromise);
  assert.equal(derived, false);
});

test('workflow applies a previous-run operating-agent result before rewriting leftover work', async () => {
  const events = [];
  const pending = {
    ...timestampEntry(),
    sentAtRaw: 'last Tuesday',
  };
  const { options, saved } = dependencies({
    initialOutbox: { version: 1, entries: [pending] },
    captureNew: false,
    readWork: async () => ({
      version: 1,
      attempt: 1,
      workId,
      items: [{
        itemKey: 'timestamp-1',
        relativeTime: 'last Tuesday',
        scanStartedAt: '2026-08-19T03:00:00.000Z',
      }],
    }),
    readResults: async ({ workId: expectedWorkId }) => {
      events.push(`read-${expectedWorkId}`);
      return {
        version: 1,
        workId: expectedWorkId,
        items: [{ itemKey: 'timestamp-1', sentAt: '2026-08-18T01:00:00.000Z' }],
      };
    },
    writeWork: async () => events.push('write'),
    notifyTimestampWork: () => events.push('notify'),
    removeSidecars: async () => events.push('cleanup'),
  });

  const result = await runPortalWorkflow(options);

  assert.deepEqual(events, [`read-${workId}`, 'cleanup']);
  assert.equal(saved.some(({ entries }) => entries[0]?.state === 'ready'), true);
  assert.equal(result.pendingTimestamps, 0);
});

test('workflow keeps leftover timestamp conversion on the locked path', async () => {
  const events = [];
  let held = false;
  const pending = {
    ...timestampEntry(),
    sentAtRaw: 'last Tuesday',
  };
  const { options } = dependencies({
    initialOutbox: { version: 1, entries: [pending] },
    captureNew: false,
    withLock: async ({ task }) => {
      events.push('lock-enter');
      held = true;
      try {
        return await task({ signal: new AbortController().signal });
      } finally {
        held = false;
        events.push('lock-exit');
      }
    },
    writeWork: async () => events.push(held ? 'write-locked' : 'write-unlocked'),
    readResults: async () => {
      events.push(held ? 'read-locked' : 'read-unlocked');
      return null;
    },
    notifyTimestampWork: () => events.push(held ? 'notify-locked' : 'notify-unlocked'),
  });

  await assert.rejects(runPortalWorkflow(options), /1 timestamp item/);
  assert.equal(events.includes('write-locked'), true);
  assert.equal(events.includes('read-locked'), true);
  assert.equal(events.includes('notify-locked'), true);
  assert.equal(events.includes('write-unlocked'), false);
  assert.equal(events.includes('read-unlocked'), false);
});
