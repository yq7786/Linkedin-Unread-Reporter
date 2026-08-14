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
    { url: 'https://www.linkedin.com/messaging/?filter=unread', title: '', bodyText: '' },
  ];
  const notices = [];
  let clock = 0;

  const result = await waitForManualRecovery({
    readState: async () => states.shift(),
    timeoutMs: 15_000,
    pollIntervalMs: 1_000,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    onBlocker: ({ type }) => notices.push(type),
  });

  assert.deepEqual(result, { recovered: true });
  assert.deepEqual(notices, ['login', 'checkpoint']);
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
  let waitedForUnread = false;
  const page = {
    url: () => 'https://www.linkedin.com/messaging/?filter=unread',
    title: async () => 'Messaging',
    evaluate: async () => '',
    waitForLoadState: async () => {},
    getByRole: () => ({
      first: () => ({
        waitFor: async ({ state }) => {
          assert.equal(state, 'visible');
          waitedForUnread = true;
        },
      }),
    }),
  };
  const adapter = new PlaywrightLinkedInAdapter(page);
  assert.deepEqual(await adapter.waitForUnblocked(1_000), { recovered: false });
  assert.equal(waitedForUnread, true);
});
