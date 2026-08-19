import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LinkedInBlockerError,
  PlaywrightLinkedInAdapter,
  waitForManualRecovery,
  withPersistentBrowser,
} from '../src/browser.js';

test('waitForManualRecovery reports blocker types and resumes when cleared', async () => {
  const states = [
    { url: 'https://www.linkedin.com/login', title: '', bodyText: '' },
    { url: 'https://www.linkedin.com/checkpoint/challenge/1', title: '', bodyText: '' },
    { url: 'https://www.linkedin.com/feed/', title: 'Feed', bodyText: '', inboxReady: false },
    { url: 'https://www.linkedin.com/messaging/?filter=unread', title: 'Messaging', bodyText: '', inboxReady: true },
    { url: 'https://www.linkedin.com/messaging/?filter=unread', title: 'Messaging', bodyText: '', inboxReady: true },
  ];
  const notices = [];
  let clock = 0;
  let reads = 0;

  const result = await waitForManualRecovery({
    readState: async () => {
      reads += 1;
      return states.shift();
    },
    timeoutMs: 15_000,
    pollIntervalMs: 1_000,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    onBlocker: ({ type }) => notices.push(type),
  });

  assert.deepEqual(result, { recovered: true });
  assert.deepEqual(notices, ['login', 'checkpoint']);
  assert.equal(reads, 5);
});

test('waitForManualRecovery retries a navigation context race inside the deadline', async () => {
  const states = [
    new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation'),
    { url: 'https://www.linkedin.com/messaging/?filter=unread', inboxReady: true },
    { url: 'https://www.linkedin.com/messaging/?filter=unread', inboxReady: true },
  ];
  let clock = 0;

  const result = await waitForManualRecovery({
    readState: async () => {
      const state = states.shift();
      if (state instanceof Error) throw state;
      return state;
    },
    timeoutMs: 5_000,
    pollIntervalMs: 500,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
  });

  assert.deepEqual(result, { recovered: false });
  assert.equal(states.length, 0);
});

test('waitForManualRecovery rejects a ready snapshot completed at the deadline', async () => {
  let clock = 0;
  let reads = 0;

  await assert.rejects(
    waitForManualRecovery({
      readState: async () => {
        reads += 1;
        if (reads === 2) clock += 500;
        return { url: 'https://www.linkedin.com/messaging/?filter=unread', inboxReady: true };
      },
      timeoutMs: 1_000,
      pollIntervalMs: 500,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
    }),
    (error) => error instanceof LinkedInBlockerError && error.type === 'inbox readiness',
  );
});

test('waitForManualRecovery does not hide unrelated or browser-closed failures', async () => {
  for (const error of [
    new Error('unexpected selector defect'),
    new Error('page.evaluate: Target page, context or browser has been closed'),
  ]) {
    await assert.rejects(
      waitForManualRecovery({
        readState: async () => { throw error; },
        timeoutMs: 5_000,
      }),
      (actual) => actual === error,
    );
  }
});

test('waitForManualRecovery times out with a sanitized error', async () => {
  let clock = 0;
  await assert.rejects(
    waitForManualRecovery({
      readState: async () => ({
        url: 'https://www.linkedin.com/checkpoint/challenge/private-id',
        title: 'Security verification for Person Name',
        bodyText: 'private page text',
      }),
      timeoutMs: 2_000,
      pollIntervalMs: 1_000,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      onBlocker: () => {},
    }),
    (error) => error instanceof LinkedInBlockerError
      && /checkpoint/.test(error.message)
      && !/private|Person Name/.test(error.message),
  );
});

test('withPersistentBrowser uses a headed persistent context and closes on success', async () => {
  const calls = [];
  const page = { marker: 'page' };
  const context = {
    pages: () => [page],
    close: async () => calls.push('close'),
  };
  const chromium = {
    launchPersistentContext: async (...args) => {
      calls.push(args);
      return context;
    },
  };

  const result = await withPersistentBrowser({
    chromium,
    profilePath: '/tmp/safe-profile',
    authTimeoutMs: 12_345,
    task: async (adapter) => ({
      marker: adapter.page.marker,
      authTimeoutMs: adapter.authTimeoutMs,
    }),
  });

  assert.deepEqual(result, { marker: 'page', authTimeoutMs: 12_345 });
  assert.equal(calls[0][0], '/tmp/safe-profile');
  assert.equal(calls[0][1].headless, false);
  assert.equal(calls.at(-1), 'close');
});

test('withPersistentBrowser closes the context after a task error', async () => {
  let closed = false;
  const chromium = {
    launchPersistentContext: async () => ({
      pages: () => [{}],
      close: async () => { closed = true; },
    }),
  };
  await assert.rejects(withPersistentBrowser({
    chromium,
    profilePath: '/tmp/safe-profile',
    task: async () => { throw new Error('expected'); },
  }), /expected/);
  assert.equal(closed, true);
});

test('withPersistentBrowser closes promptly on a mid-navigation abort and gives the signal reason precedence', async () => {
  const controller = new AbortController();
  const compromise = new Error('Outbox lock failed.');
  const privateBrowserError = new Error('navigation failed for a private thread');
  let closeCalls = 0;
  let rejectNavigation;
  const page = {
    goto: async () => new Promise((_resolve, reject) => { rejectNavigation = reject; }),
  };
  const context = {
    pages: () => [page],
    close: async () => {
      closeCalls += 1;
      rejectNavigation(privateBrowserError);
    },
  };

  const operation = withPersistentBrowser({
    chromium: { launchPersistentContext: async () => context },
    profilePath: '/tmp/safe-profile',
    signal: controller.signal,
    task: (adapter) => adapter.gotoUnread('https://www.linkedin.com/messaging/?filter=unread'),
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(compromise);

  await assert.rejects(operation, (error) => error === compromise);
  assert.equal(closeCalls, 1);
});

test('withPersistentBrowser gives an abort reason precedence over an in-flight launch failure', async () => {
  const controller = new AbortController();
  const compromise = new Error('Outbox lock failed.');
  let rejectLaunch;
  const operation = withPersistentBrowser({
    chromium: {
      launchPersistentContext: async () => new Promise((_resolve, reject) => {
        rejectLaunch = reject;
      }),
    },
    profilePath: '/tmp/safe-profile',
    signal: controller.signal,
    task: async () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(compromise);
  rejectLaunch(new Error('private launch failure'));

  await assert.rejects(operation, (error) => error === compromise);
});

test('withPersistentBrowser closes a context that resolves from launch after abort', async () => {
  const controller = new AbortController();
  const compromise = new Error('Outbox lock failed.');
  let resolveLaunch;
  let closeCalls = 0;
  const context = {
    pages: () => [{}],
    close: async () => { closeCalls += 1; },
  };
  const operation = withPersistentBrowser({
    chromium: {
      launchPersistentContext: async () => new Promise((resolve) => { resolveLaunch = resolve; }),
    },
    profilePath: '/tmp/safe-profile',
    signal: controller.signal,
    task: async () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(compromise);
  resolveLaunch(context);

  await assert.rejects(operation, (error) => error === compromise);
  assert.equal(closeCalls, 1);
});

test('withPersistentBrowser does not launch for a pre-aborted signal', async () => {
  const controller = new AbortController();
  const compromise = new Error('Outbox lock failed.');
  controller.abort(compromise);
  let launches = 0;
  await assert.rejects(withPersistentBrowser({
    chromium: { launchPersistentContext: async () => { launches += 1; } },
    profilePath: '/tmp/safe-profile',
    signal: controller.signal,
    task: async () => {},
  }), (error) => error === compromise);
  assert.equal(launches, 0);
});

test('withPersistentBrowser removes its abort listener after success', async () => {
  const controller = new AbortController();
  const signal = controller.signal;
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  let added;
  let removed;
  signal.addEventListener = (type, listener, options) => {
    added = listener;
    return originalAdd(type, listener, options);
  };
  signal.removeEventListener = (type, listener, options) => {
    removed = listener;
    return originalRemove(type, listener, options);
  };
  await withPersistentBrowser({
    chromium: { launchPersistentContext: async () => ({ pages: () => [{}], close: async () => {} }) },
    profilePath: '/tmp/safe-profile',
    signal,
    task: async () => {},
  });
  assert.equal(typeof added, 'function');
  assert.equal(removed, added);
});

test('withPersistentBrowser aborts a mid-read before postwork and closes context', async () => {
  const controller = new AbortController();
  const compromise = new Error('Outbox lock failed.');
  let rejectRead;
  let closeCalls = 0;
  let postwork = 0;
  const page = {
    url: () => 'https://www.linkedin.com/messaging/thread/read-abort/',
    evaluate: async () => new Promise((_resolve, reject) => { rejectRead = reject; }),
  };
  const operation = withPersistentBrowser({
    chromium: { launchPersistentContext: async () => ({
      pages: () => [page],
      close: async () => { closeCalls += 1; rejectRead(new Error('private read failure')); },
    }) },
    profilePath: '/tmp/safe-profile',
    signal: controller.signal,
    task: async (adapter) => {
      await adapter.readThreadMessages();
      postwork += 1;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(compromise);
  await assert.rejects(operation, (error) => error === compromise);
  assert.equal(closeCalls, 1);
  assert.equal(postwork, 0);
});

test('withPersistentBrowser aborts a mid-click row open before checkpoint or extraction', async () => {
  const controller = new AbortController();
  const compromise = new Error('Outbox lock failed.');
  let closeCalls = 0;
  let rejectClick;
  let checkpoints = 0;
  let extractions = 0;
  const row = {
    evaluate: async () => true,
    click: async () => new Promise((_resolve, reject) => { rejectClick = reject; }),
  };
  const rows = {
    filter() { return this; },
    count: async () => 1,
    first: () => row,
  };
  const list = { locator: () => rows };
  const lists = {
    filter() { return this; },
    count: async () => 1,
    first: () => list,
  };
  const page = {
    evaluate: async (_fn, value) => value,
    locator: () => lists,
  };
  const context = {
    pages: () => [page],
    close: async () => {
      closeCalls += 1;
      rejectClick(new Error('click failed for private row'));
    },
  };

  const operation = withPersistentBrowser({
    chromium: { launchPersistentContext: async () => context },
    profilePath: '/tmp/safe-profile',
    signal: controller.signal,
    task: async (adapter) => {
      await adapter.openConversation(
        { rowId: 'opaque-row', conversationUrl: null },
        { onOpened: async () => { checkpoints += 1; } },
      );
      extractions += 1;
      await adapter.readThreadMessages();
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(compromise);

  await assert.rejects(operation, (error) => error === compromise);
  assert.equal(closeCalls, 1);
  assert.equal(checkpoints, 0);
  assert.equal(extractions, 0);
});

test('withPersistentBrowser sanitizes an otherwise primary browser close failure', async () => {
  const privateCloseError = new Error('failed to close /private/browser/profile');
  await assert.rejects(withPersistentBrowser({
    chromium: {
      launchPersistentContext: async () => ({
        pages: () => [{}],
        close: async () => { throw privateCloseError; },
      }),
    },
    profilePath: '/tmp/safe-profile',
    task: async () => 'complete',
  }), (error) => error !== privateCloseError
    && error.message === 'Browser cleanup failed.');
});

test('Playwright adapter waits for the visible Unread control instead of a fixed delay', async () => {
  let snapshots = 0;
  const page = {
    url: () => 'https://www.linkedin.com/messaging/?filter=unread',
    evaluate: async () => {
      snapshots += 1;
      return {
        title: 'Messaging',
        bodyText: '',
        inboxReady: true,
      };
    },
  };
  const adapter = new PlaywrightLinkedInAdapter(page);
  assert.deepEqual(await adapter.waitForUnblocked(5_000), { recovered: false });
  assert.equal(snapshots, 2);
});

test('Playwright adapter re-enters unread after a blocker clears onto the feed', async () => {
  const unreadUrl = 'https://www.linkedin.com/messaging/?filter=unread';
  const gotoCalls = [];
  let evaluations = 0;
  let clock = 0;
  const page = {
    goto: async (url) => { gotoCalls.push(url); },
    evaluate: async () => {
      evaluations += 1;
      if (evaluations === 1) {
        return { url: 'https://www.linkedin.com/login', inboxReady: false };
      }
      if (gotoCalls.length === 1) {
        return { url: 'https://www.linkedin.com/feed/', inboxReady: false };
      }
      return { url: unreadUrl, inboxReady: true };
    },
  };
  const adapter = new PlaywrightLinkedInAdapter(page);

  await adapter.gotoUnread(unreadUrl);
  assert.deepEqual(await adapter.waitForUnblocked(1_000, {
    pollIntervalMs: 10,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
  }), { recovered: true });
  assert.deepEqual(gotoCalls, [unreadUrl, unreadUrl]);
});

test('readUnreadCandidates rejects invalid limits before touching the DOM', async () => {
  let locatorCalls = 0;
  const adapter = new PlaywrightLinkedInAdapter({
    locator: () => {
      locatorCalls += 1;
      throw new Error('DOM must not be touched');
    },
  });

  for (const limit of [0, 51, 1.5, '2']) {
    await assert.rejects(
      adapter.readUnreadCandidates({ limit }),
      (error) => error.code === 'candidate-limit-invalid',
    );
  }
  assert.equal(locatorCalls, 0);
});

test('openConversation recovers a URL-only thread from login and re-enters its validated URL', async () => {
  const threadUrl = 'https://www.linkedin.com/messaging/thread/recovery-thread/';
  const gotoCalls = [];
  const notices = [];
  let evaluations = 0;
  let clock = 0;
  const page = {
    goto: async (url) => { gotoCalls.push(url); },
    url: () => gotoCalls.length > 1 ? threadUrl : 'https://www.linkedin.com/login',
    evaluate: async () => {
      evaluations += 1;
      if (evaluations === 1) {
        return { url: 'https://www.linkedin.com/login', threadCount: 0 };
      }
      if (gotoCalls.length === 1) {
        return { url: 'https://www.linkedin.com/feed/', threadCount: 0 };
      }
      return { url: threadUrl, threadCount: 1 };
    },
  };
  const adapter = new PlaywrightLinkedInAdapter(page, {
    authTimeoutMs: 1_000,
    recoveryOptions: {
      pollIntervalMs: 10,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
    },
    onBlocker: ({ type }) => notices.push(type),
  });

  assert.equal(await adapter.openConversation({ conversationUrl: threadUrl }), threadUrl);
  assert.deepEqual(notices, ['login']);
  assert.deepEqual(gotoCalls, [threadUrl, threadUrl]);
});

test('openConversation re-enters the requested thread even if manual recovery lands on another thread', async () => {
  const requestedUrl = 'https://www.linkedin.com/messaging/thread/requested-thread/';
  const otherUrl = 'https://www.linkedin.com/messaging/thread/other-private-thread/';
  const gotoCalls = [];
  let reads = 0;
  let clock = 0;
  const page = {
    goto: async (url) => { gotoCalls.push(url); },
    url: () => gotoCalls.length > 1 ? requestedUrl : otherUrl,
    evaluate: async () => {
      reads += 1;
      if (reads === 1) return { url: 'https://www.linkedin.com/login', threadCount: 0 };
      if (gotoCalls.length === 1) return { url: otherUrl, threadCount: 1 };
      return { url: requestedUrl, threadCount: 1 };
    },
  };
  const adapter = new PlaywrightLinkedInAdapter(page, {
    authTimeoutMs: 1_000,
    recoveryOptions: {
      pollIntervalMs: 10,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
    },
  });

  assert.equal(await adapter.openConversation({ conversationUrl: requestedUrl }), requestedUrl);
  assert.deepEqual(gotoCalls, [requestedUrl, requestedUrl]);
});

test('openConversation checkpoints a canonical URL before waiting for thread readiness', async () => {
  const events = [];
  const threadUrl = 'https://www.linkedin.com/messaging/thread/checkpoint-order/';
  const page = {
    goto: async () => events.push('navigate'),
    url: () => threadUrl,
    evaluate: async () => {
      events.push('readiness');
      return { url: threadUrl, threadCount: 1 };
    },
  };
  const adapter = new PlaywrightLinkedInAdapter(page, {
    recoveryOptions: { pollIntervalMs: 0, sleep: async () => {} },
  });

  await adapter.openConversation(
    { conversationUrl: threadUrl },
    { onOpened: async (url) => events.push(`checkpoint:${url}`) },
  );

  assert.deepEqual(events.slice(0, 3), ['navigate', `checkpoint:${threadUrl}`, 'readiness']);
});

test('openConversation waits for a delayed anchorless SPA URL before checkpointing and readiness', async () => {
  const events = [];
  const threadUrl = 'https://www.linkedin.com/messaging/thread/delayed-spa/';
  let currentUrl = 'https://www.linkedin.com/messaging/?filter=unread';
  const row = {
    evaluate: async () => true,
    click: async () => { events.push('click'); currentUrl = threadUrl; },
  };
  const rows = {
    filter() { return this; },
    count: async () => 1,
    first: () => row,
  };
  const list = { locator: () => rows };
  const lists = {
    filter() { return this; },
    count: async () => 1,
    first: () => list,
  };
  const page = {
    locator: () => lists,
    evaluate: async (fn, value) => {
      if (typeof value === 'string') return value;
      if (value?.activeSelector) {
        events.push('identity');
        return { listCount: 1, activeRowIds: ['delayed-row'] };
      }
      if (value?.threadSelector) {
        events.push('readiness');
        return { url: currentUrl, threadCount: 1 };
      }
      events.push('transition');
      return { url: currentUrl, title: '', bodyText: '' };
    },
    url: () => currentUrl,
  };
  const adapter = new PlaywrightLinkedInAdapter(page, {
    authTimeoutMs: 4_321,
    recoveryOptions: { pollIntervalMs: 0, sleep: async () => {} },
  });

  await adapter.openConversation(
    { rowId: 'delayed-row', conversationUrl: null },
    { onOpened: async (url) => events.push(`checkpoint:${url}`) },
  );

  assert.ok(events.indexOf('identity') < events.indexOf(`checkpoint:${threadUrl}`));
  assert.ok(events.indexOf(`checkpoint:${threadUrl}`) < events.indexOf('readiness'));
});

test('openConversation sanitizes checkpoint callback failures and stops before readiness', async () => {
  const privateFailure = 'private outbox path failed';
  let readinessCalls = 0;
  const threadUrl = 'https://www.linkedin.com/messaging/thread/checkpoint-failure/';
  const adapter = new PlaywrightLinkedInAdapter({
    goto: async () => {},
    url: () => threadUrl,
    evaluate: async () => {
      readinessCalls += 1;
      return { url: threadUrl, threadCount: 1 };
    },
  });

  await assert.rejects(
    adapter.openConversation(
      { conversationUrl: threadUrl },
      { onOpened: async () => { throw new Error(privateFailure); } },
    ),
    (error) => error.code === 'conversation-open-checkpoint-failed'
      && !error.message.includes(privateFailure),
  );
  assert.equal(readinessCalls, 0);
});

test('openConversation sanitizes browser failures that contain private URLs and row identities', async () => {
  const privateUrl = 'https://www.linkedin.com/messaging/thread/private-thread-id/';
  const directAdapter = new PlaywrightLinkedInAdapter({
    goto: async () => { throw new Error(`navigation failed for ${privateUrl}`); },
  });
  await assert.rejects(
    directAdapter.openConversation({ conversationUrl: privateUrl }),
    (error) => error.name === 'ScanInvariantError'
      && !error.message.includes(privateUrl)
      && !error.message.includes('private-thread-id'),
  );

  const privateRowId = 'private-row-id';
  const fallbackAdapter = new PlaywrightLinkedInAdapter({
    locator: () => { throw new Error(`locator failed for ${privateRowId}`); },
  });
  await assert.rejects(
    fallbackAdapter.openConversation({ rowId: privateRowId, conversationUrl: null }),
    (error) => error.name === 'ScanInvariantError' && !error.message.includes(privateRowId),
  );
});
