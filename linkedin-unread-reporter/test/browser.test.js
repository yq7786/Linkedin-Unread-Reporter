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
    task: async (adapter) => adapter.page.marker,
  });

  assert.equal(result, 'page');
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
