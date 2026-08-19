import assert from 'node:assert/strict';
import test from 'node:test';

import { createEmptyOutbox, validateOutbox } from '../src/outbox.js';
import { captureUnreadMessages, scanUnreadConversations } from '../src/scanner.js';
import { LinkedInBlockerError } from '../src/browser.js';
import { ScanInvariantError } from '../src/linkedin-state.js';
import { createIdempotencyKey } from '../src/messages.js';

const unreadUrl = 'https://www.linkedin.com/messaging/?filter=unread';
const scanStartedAt = new Date('2026-08-19T03:00:00.000Z');
const threadUrl = (id) => `https://www.linkedin.com/messaging/thread/${id}/`;
const candidate = (id, extra = {}) => ({
  rowId: `row-${id}`,
  leadName: `Person ${id}`,
  unreadCount: 1,
  conversationUrl: threadUrl(id),
  ...extra,
});
const message = (content, extra = {}) => ({
  linkedinMessageId: `message-${content}`,
  direction: 'inbound',
  contentType: 'text',
  content,
  sentAt: '2026-08-19T02:00:00.000Z',
  sentAtRaw: '11:30am',
  ...extra,
});

class CaptureAdapter {
  constructor({ candidates = [], snapshots = {}, events = [] } = {}) {
    this.candidates = candidates;
    this.snapshots = snapshots;
    this.events = events;
    this.currentUrl = null;
    this.openCalls = 0;
    this.gotoCalls = 0;
    this.readCandidateCalls = 0;
    this.openedRowIds = new Set();
  }

  async gotoUnread(url) {
    assert.equal(url, unreadUrl);
    this.gotoCalls += 1;
    this.events.push(['gotoUnread']);
  }

  async waitForUnblocked() {
    this.events.push(['waitForUnblocked']);
    return { recovered: false };
  }

  async readUnreadCandidates({ limit, excludeRowIds }) {
    this.readCandidateCalls += 1;
    this.events.push(['readUnreadCandidates', limit, [...excludeRowIds]]);
    const excluded = new Set(excludeRowIds);
    return this.candidates
      .filter(({ rowId }) => !this.openedRowIds.has(rowId) && !excluded.has(rowId))
      .slice(0, limit)
      .map((value) => structuredClone(value));
  }

  async openConversation(value, { onOpened } = {}) {
    this.openCalls += 1;
    const resolvedUrl = value.conversationUrl || threadUrl(value.rowId.replace(/^row-/, ''));
    this.events.push(['openConversation', value.rowId ?? null, value.conversationUrl]);
    if (value.rowId) this.openedRowIds.add(value.rowId);
    const parsed = new URL(resolvedUrl);
    this.currentUrl = `${parsed.origin}${parsed.pathname}`;
    if (onOpened) {
      await onOpened(this.currentUrl);
      this.events.push(['openReady']);
    }
    return this.currentUrl;
  }

  async readThreadMessages() {
    this.events.push(['readThreadMessages', this.currentUrl]);
    const snapshot = this.snapshots[this.currentUrl];
    if (snapshot instanceof Error) throw snapshot;
    if (typeof snapshot === 'function') return snapshot();
    return structuredClone(snapshot);
  }
}

function captureOptions(adapter, overrides = {}) {
  const saved = [];
  return {
    saved,
    options: {
      adapter,
      outbox: createEmptyOutbox(),
      saveOutbox: async (value) => {
        validateOutbox(value);
        saved.push(structuredClone(value));
      },
      unreadUrl,
      scanStartedAt,
      cap: 50,
      authTimeoutMs: 10,
      ...overrides,
    },
  };
}

test('captureUnreadMessages persists a direct-URL recovery marker before opening a new thread', async () => {
  const events = [];
  const adapter = new CaptureAdapter({
    candidates: [candidate('one')],
    snapshots: {
      [threadUrl('one')]: {
        conversationUrl: threadUrl('one'),
        unreadBoundaryIndex: 0,
        messages: [message('one')],
      },
    },
    events,
  });
  const { options, saved } = captureOptions(adapter);
  options.saveOutbox = async (value) => {
    validateOutbox(value);
    events.push(['saveOutbox', value.entries[0]?.state]);
    saved.push(structuredClone(value));
  };

  await captureUnreadMessages(options);

  assert.deepEqual(events.map(([type]) => type), [
    'gotoUnread', 'waitForUnblocked', 'readUnreadCandidates',
    'saveOutbox', 'openConversation', 'readThreadMessages', 'saveOutbox',
    'gotoUnread', 'waitForUnblocked', 'readUnreadCandidates',
  ]);
  assert.equal(saved[0].entries[0].state, 'capture_pending');
  assert.equal(saved[1].entries[0].state, 'ready');
});

test('captureUnreadMessages checkpoints an anchorless thread through onOpened before extraction', async () => {
  const events = [];
  const adapter = new CaptureAdapter({
    candidates: [candidate('anchorless', { conversationUrl: null })],
    snapshots: {
      [threadUrl('anchorless')]: {
        conversationUrl: threadUrl('anchorless'),
        unreadBoundaryIndex: 0,
        messages: [message('anchorless')],
      },
    },
    events,
  });
  const { options } = captureOptions(adapter);
  options.saveOutbox = async (value) => {
    validateOutbox(value);
    events.push(['saveOutbox', value.entries.at(-1)?.state]);
  };

  await captureUnreadMessages(options);

  assert.deepEqual(events.map(([type]) => type).slice(3, 8), [
    'openConversation', 'saveOutbox', 'openReady', 'readThreadMessages', 'saveOutbox',
  ]);
});

test('captureUnreadMessages leaves an anchorless marker durable if opening crashes after onOpened', async () => {
  const durable = [];
  const crash = new Error('browser closed after click');
  const adapter = new CaptureAdapter({ candidates: [candidate('crash', { conversationUrl: null })] });
  adapter.openConversation = async (value, { onOpened }) => {
    adapter.openCalls += 1;
    await onOpened(threadUrl('crash'));
    throw crash;
  };
  const { options } = captureOptions(adapter);
  options.saveOutbox = async (value) => durable.push(structuredClone(value));

  await assert.rejects(captureUnreadMessages(options), crash);

  assert.equal(durable.length, 1);
  assert.equal(durable[0].entries[0].state, 'capture_pending');
  assert.equal(durable[0].entries[0].conversationUrl, threadUrl('crash'));
});

test('captureUnreadMessages checkpoints a completed conversation before opening the next', async () => {
  const events = [];
  const candidates = [candidate('one'), candidate('two')];
  const snapshots = Object.fromEntries(candidates.map(({ conversationUrl }, index) => [
    conversationUrl,
    { conversationUrl, unreadBoundaryIndex: 0, messages: [message(`captured-${index}`)] },
  ]));
  const adapter = new CaptureAdapter({ candidates, snapshots, events });
  const { options } = captureOptions(adapter);
  options.saveOutbox = async (value) => {
    validateOutbox(value);
    events.push(['saveOutbox', value.entries.at(-1)?.state]);
  };

  const result = await captureUnreadMessages(options);

  const secondOpen = events.findIndex((event) => (
    event[0] === 'openConversation' && event[2] === threadUrl('two')
  ));
  const firstReadySave = events.findIndex((event) => event[0] === 'saveOutbox' && event[1] === 'ready');
  assert.ok(firstReadySave < secondOpen);
  assert.equal(result.processedConversations, 2);
  assert.equal(result.capturedMessages, 2);
});

test('captureUnreadMessages uses boundary, count, then newest fallback selection', async () => {
  const rows = [
    candidate('boundary', { unreadCount: 1 }),
    candidate('count', { unreadCount: 2 }),
    candidate('newest', { unreadCount: null }),
  ];
  const snapshots = {
    [threadUrl('boundary')]: {
      conversationUrl: threadUrl('boundary'),
      unreadBoundaryIndex: 2,
      messages: [message('old'), message('sent', { direction: 'outbound' }), message('boundary-new')],
    },
    [threadUrl('count')]: {
      conversationUrl: threadUrl('count'),
      unreadBoundaryIndex: null,
      messages: [message('count-old'), message('count-first'), message('count-second')],
    },
    [threadUrl('newest')]: {
      conversationUrl: threadUrl('newest'),
      unreadBoundaryIndex: null,
      messages: [message('newest-old'), message('newest-last')],
    },
  };
  const adapter = new CaptureAdapter({ candidates: rows, snapshots });
  const { options } = captureOptions(adapter);

  const result = await captureUnreadMessages(options);

  assert.deepEqual(
    result.outbox.entries.map(({ content }) => content),
    ['boundary-new', 'count-first', 'count-second', 'newest-last'],
  );
  assert.equal(result.capturedMessages, 4);
});

test('captureUnreadMessages creates strict ready and timestamp_pending entries with canonical URLs', async () => {
  const rawUrl = `${threadUrl('timestamps')}?filter=unread#latest`;
  const adapter = new CaptureAdapter({
    candidates: [candidate('timestamps', { conversationUrl: rawUrl, unreadCount: 2 })],
    snapshots: {
      [threadUrl('timestamps')]: {
        conversationUrl: threadUrl('timestamps'),
        unreadBoundaryIndex: 0,
        messages: [
          message('exact'),
          message('relative', { linkedinMessageId: null, sentAt: null, sentAtRaw: '2h' }),
        ],
      },
    },
  });
  const { options } = captureOptions(adapter);

  const result = await captureUnreadMessages(options);

  assert.deepEqual(Object.keys(result.outbox.entries[0]).sort(), [
    'content', 'contentType', 'conversationUrl', 'entryId', 'idempotencyKey',
    'leadName', 'linkedinMessageId', 'sentAt', 'sentAtAccuracy', 'sentAtRaw', 'state',
  ].sort());
  assert.equal(result.outbox.entries[0].state, 'ready');
  assert.equal(result.outbox.entries[0].sentAtAccuracy, 'exact');
  assert.equal(result.outbox.entries[0].conversationUrl, threadUrl('timestamps'));
  assert.deepEqual(Object.keys(result.outbox.entries[1]).sort(), [
    'content', 'contentType', 'conversationUrl', 'entryId', 'leadName',
    'linkedinMessageId', 'scanStartedAt', 'sentAtRaw', 'state',
  ].sort());
  assert.equal(result.outbox.entries[1].state, 'timestamp_pending');
  assert.equal(result.outbox.entries[1].scanStartedAt, scanStartedAt.toISOString());
  assert.equal(result.pendingTimestamps, 1);
});

test('captureUnreadMessages retries a direct URL three times then retains capture_pending', async () => {
  const adapter = new CaptureAdapter({
    candidates: [candidate('failure', { unreadCount: 2 })],
    snapshots: { [threadUrl('failure')]: new ScanInvariantError('message-list-missing') },
  });
  const { options, saved } = captureOptions(adapter);

  const result = await captureUnreadMessages(options);

  assert.equal(adapter.openCalls, 3);
  assert.equal(saved[0].entries[0].attemptCount, 1);
  assert.equal(result.outbox.entries[0].state, 'capture_pending');
  assert.equal(result.outbox.entries[0].expectedUnreadCount, 2);
  assert.equal(result.outbox.entries[0].attemptCount, 3);
  assert.equal(result.pendingRecovery, 1);
  assert.equal(result.capturedMessages, 0);
});

test('captureUnreadMessages treats a sanitized snapshot URL mismatch as recoverable', async () => {
  const adapter = new CaptureAdapter({
    candidates: [candidate('mismatch')],
    snapshots: {
      [threadUrl('mismatch')]: {
        conversationUrl: threadUrl('other'),
        unreadBoundaryIndex: 0,
        messages: [message('mismatch')],
      },
    },
  });
  const { options } = captureOptions(adapter);

  const result = await captureUnreadMessages(options);

  assert.equal(adapter.openCalls, 3);
  assert.equal(result.outbox.entries[0].state, 'capture_pending');
});

test('captureUnreadMessages retains recovery when selection contains no unread inbound messages', async () => {
  for (const [id, snapshot] of [
    ['boundary-end', {
      conversationUrl: threadUrl('boundary-end'),
      unreadBoundaryIndex: 1,
      messages: [message('old')],
    }],
    ['all-outbound', {
      conversationUrl: threadUrl('all-outbound'),
      unreadBoundaryIndex: null,
      messages: [message('sent', { direction: 'outbound' })],
    }],
  ]) {
    const adapter = new CaptureAdapter({
      candidates: [candidate(id, { unreadCount: null })],
      snapshots: { [threadUrl(id)]: snapshot },
    });
    const { options } = captureOptions(adapter);

    const result = await captureUnreadMessages(options);

    assert.equal(result.outbox.entries.length, 1);
    assert.equal(result.outbox.entries[0].state, 'capture_pending');
    assert.equal(result.outbox.entries[0].attemptCount, 3);
  }
});

test('captureUnreadMessages propagates blockers, browser closure, and unexpected extraction errors', async () => {
  for (const error of [
    new LinkedInBlockerError('captcha'),
    new Error('Target page, context or browser has been closed'),
    new Error('unexpected extraction defect'),
    new ScanInvariantError('thread-message-read-failed'),
  ]) {
    const adapter = new CaptureAdapter({
      candidates: [candidate('fatal')],
      snapshots: { [threadUrl('fatal')]: error },
    });
    const { options, saved } = captureOptions(adapter);

    await assert.rejects(captureUnreadMessages(options), (actual) => actual === error);

    assert.equal(adapter.openCalls, 1);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].entries[0].state, 'capture_pending');
  }
});

test('captureUnreadMessages validates cap before any adapter call', async () => {
  for (const cap of [0, 51, 1.5, '2']) {
    const adapter = new CaptureAdapter();
    const { options } = captureOptions(adapter, { cap });

    await assert.rejects(captureUnreadMessages(options), /cap/i);

    assert.deepEqual(adapter.events, []);
  }
});

test('captureUnreadMessages rejects coercible message fields and non-ISO exact timestamps', async () => {
  const invalidOverrides = [
    { linkedinMessageId: 42 },
    { contentType: 42 },
    { content: 42 },
    { sentAtRaw: 42 },
    { sentAt: 'August 19, 2026 at 11:30 AM' },
  ];
  for (const [index, override] of invalidOverrides.entries()) {
    const id = `strict-${index}`;
    const adapter = new CaptureAdapter({
      candidates: [candidate(id)],
      snapshots: {
        [threadUrl(id)]: {
          conversationUrl: threadUrl(id),
          unreadBoundaryIndex: 0,
          messages: [message(id, override)],
        },
      },
    });
    const { options } = captureOptions(adapter);

    const result = await captureUnreadMessages(options);

    assert.equal(result.outbox.entries[0].state, 'capture_pending');
  }
});

test('captureUnreadMessages rejects duplicate selected stable IDs and idempotency keys', async () => {
  for (const [id, messages] of [
    ['duplicate-id', [message('first', { linkedinMessageId: 'same' }), message('second', { linkedinMessageId: 'same' })]],
    ['duplicate-key', [
      message('first', { linkedinMessageId: null }),
      message('second', { linkedinMessageId: null }),
    ]],
  ]) {
    const adapter = new CaptureAdapter({
      candidates: [candidate(id, { unreadCount: 2 })],
      snapshots: {
        [threadUrl(id)]: {
          conversationUrl: threadUrl(id),
          unreadBoundaryIndex: 0,
          messages,
        },
      },
    });
    const { options } = captureOptions(adapter);

    const result = await captureUnreadMessages(options);

    assert.equal(result.outbox.entries.length, 1);
    assert.equal(result.outbox.entries[0].state, 'capture_pending');
  }
});

test('captureUnreadMessages skips stable messages already present in the outbox', async () => {
  const url = threadUrl('existing');
  const existing = {
    entryId: 'existing-ready',
    state: 'ready',
    idempotencyKey: 'linkedin:already-captured',
    linkedinMessageId: 'already-captured',
    leadName: 'Existing Person',
    conversationUrl: url,
    contentType: 'text',
    content: 'Existing content',
    sentAt: '2026-08-19T02:00:00.000Z',
    sentAtRaw: '11:30am',
    sentAtAccuracy: 'exact',
  };
  const existingFallback = {
    ...existing,
    entryId: 'existing-fallback',
    idempotencyKey: createIdempotencyKey({
      linkedinMessageId: null,
      leadName: 'Person existing',
      sentAt: '2026-08-19T02:00:00.000Z',
      conversationUrl: url,
    }),
    linkedinMessageId: null,
    leadName: 'Person existing',
  };
  const adapter = new CaptureAdapter({
    candidates: [candidate('existing', { unreadCount: 2 })],
    snapshots: {
      [url]: {
        conversationUrl: url,
        unreadBoundaryIndex: 0,
        messages: [
          message('duplicate', { linkedinMessageId: 'already-captured' }),
          message('duplicate fallback', { linkedinMessageId: null }),
        ],
      },
    },
  });
  const { options } = captureOptions(adapter, {
    outbox: { version: 1, entries: [existing, existingFallback] },
  });

  const result = await captureUnreadMessages(options);

  assert.deepEqual(result.outbox.entries, [existing, existingFallback]);
  assert.equal(result.capturedMessages, 0);
});

test('captureUnreadMessages propagates a replacement checkpoint failure without re-extracting', async () => {
  const adapter = new CaptureAdapter({
    candidates: [candidate('checkpoint')],
    snapshots: {
      [threadUrl('checkpoint')]: {
        conversationUrl: threadUrl('checkpoint'),
        unreadBoundaryIndex: 0,
        messages: [message('checkpoint')],
      },
    },
  });
  const checkpointError = new Error('fixture checkpoint failure');
  let saveCalls = 0;
  const { options } = captureOptions(adapter);
  options.saveOutbox = async (value) => {
    validateOutbox(value);
    saveCalls += 1;
    if (saveCalls === 2) throw checkpointError;
  };

  await assert.rejects(captureUnreadMessages(options), checkpointError);

  assert.equal(adapter.events.filter(([type]) => type === 'readThreadMessages').length, 1);
});

test('captureUnreadMessages processes stored recovery markers before discovering new rows', async () => {
  const events = [];
  const recoveryUrl = threadUrl('recovery');
  const adapter = new CaptureAdapter({
    candidates: [candidate('new')],
    snapshots: {
      [recoveryUrl]: {
        conversationUrl: recoveryUrl,
        unreadBoundaryIndex: null,
        messages: [message('recovered-old'), message('recovered-new')],
      },
      [threadUrl('new')]: {
        conversationUrl: threadUrl('new'),
        unreadBoundaryIndex: 0,
        messages: [message('new')],
      },
    },
    events,
  });
  const marker = {
    entryId: 'capture:recovery',
    state: 'capture_pending',
    leadName: 'Recovery Person',
    conversationUrl: recoveryUrl,
    expectedUnreadCount: 1,
    firstFailureAt: '2026-08-18T03:00:00.000Z',
    attemptCount: 3,
  };
  const { options } = captureOptions(adapter, { outbox: { version: 1, entries: [marker] } });

  const result = await captureUnreadMessages(options);

  assert.equal(events[0][0], 'openConversation');
  assert.equal(events[0][2], recoveryUrl);
  assert.deepEqual(result.outbox.entries.map(({ content }) => content), ['recovered-new', 'new']);
  assert.equal(result.processedConversations, 2);
});

test('captureUnreadMessages does not reopen a new candidate matching a processed recovery URL', async () => {
  const url = threadUrl('same-recovery');
  const marker = {
    entryId: 'capture:same-recovery',
    state: 'capture_pending',
    leadName: 'Recovery Person',
    conversationUrl: url,
    expectedUnreadCount: 1,
    firstFailureAt: '2026-08-18T03:00:00.000Z',
    attemptCount: 1,
  };
  const adapter = new CaptureAdapter({
    candidates: [candidate('same-recovery')],
    snapshots: {
      [url]: {
        conversationUrl: url,
        unreadBoundaryIndex: null,
        messages: [message('recovered')],
      },
    },
  });
  const { options } = captureOptions(adapter, { outbox: { version: 1, entries: [marker] } });

  const result = await captureUnreadMessages(options);

  assert.equal(adapter.openCalls, 1);
  assert.equal(result.processedConversations, 1);
  assert.deepEqual(result.outbox.entries.map(({ content }) => content), ['recovered']);
});

test('captureUnreadMessages refreshes discovery after every conversation and caps at 50', async () => {
  const rows = Array.from({ length: 51 }, (_, index) => candidate(String(index)));
  const snapshots = Object.fromEntries(rows.map(({ conversationUrl }, index) => [
    conversationUrl,
    { conversationUrl, unreadBoundaryIndex: 0, messages: [message(`cap-${index}`)] },
  ]));
  const adapter = new CaptureAdapter({ candidates: rows, snapshots });
  const { options } = captureOptions(adapter);

  const result = await captureUnreadMessages(options);

  assert.equal(adapter.openCalls, 50);
  assert.equal(adapter.gotoCalls, 51);
  assert.equal(adapter.readCandidateCalls, 51);
  assert.equal(result.processedConversations, 50);
  assert.equal(result.capturedMessages, 50);
  assert.equal(result.truncated, true);
});

test('legacy scan export remains available until the CLI migration', async () => {
  const adapter = {
    gotoUnread: async () => {},
    waitForUnblocked: async () => ({ recovered: false }),
    inspectState: async () => ({
      unreadFilterPressed: true,
      conversationListPresent: true,
      conversationListCount: 1,
      activeRowCount: 0,
      detailPaneVisible: false,
    }),
    readRows: async () => [],
    hasLoadMore: async () => false,
    scrollList: async () => false,
    waitForStability: async () => {},
  };
  assert.deepEqual(await scanUnreadConversations({
    adapter, unreadUrl, authTimeoutMs: 10, requiredStablePasses: 1,
  }), { conversations: [], truncated: false });
});
