import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { LinkedInBlockerError, PlaywrightLinkedInAdapter } from '../src/browser.js';
import { normalizeConversationRow, ScanInvariantError } from '../src/linkedin-state.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function browserTest(name, callback) {
  test(name, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await callback(page);
    } finally {
      await browser.close();
    }
  });
}

browserTest('Playwright adapter extracts only row metadata from the unread fixture', async (page) => {
  await page.setContent(await fs.readFile(path.join(fixtures, 'unread-list.html'), 'utf8'));
  const adapter = new PlaywrightLinkedInAdapter(page);

  assert.deepEqual(await adapter.inspectState(), {
    unreadFilterPressed: true,
    conversationListPresent: true,
    conversationListCount: 1,
    activeRowCount: 0,
    detailPaneVisible: false,
  });
  const rows = await adapter.readRows();
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(normalizeConversationRow).filter(Boolean), [
    { id: 'row-1', name: 'Ada Lovelace' },
  ]);
  assert.equal(JSON.stringify(rows).includes('message preview'), false);
});

browserTest('readUnreadCandidates returns eligible humans with URL and count metadata only', async (page) => {
  const fixture = await fs.readFile(path.join(fixtures, 'unread-candidates.html'), 'utf8');
  await page.setContent(fixture);
  const adapter = new PlaywrightLinkedInAdapter(page);

  const candidates = await adapter.readUnreadCandidates({ limit: 50 });

  assert.deepEqual(candidates, [
    {
      rowId: 'human-1',
      leadName: 'Ada',
      unreadCount: 2,
      conversationUrl: 'https://www.linkedin.com/messaging/thread/thread-1/',
    },
    {
      rowId: 'human-2',
      leadName: 'Grace',
      unreadCount: null,
      conversationUrl: null,
    },
    {
      rowId: 'human-3',
      leadName: 'Katherine',
      unreadCount: 1,
      conversationUrl: null,
    },
  ]);
  assert.deepEqual(Object.keys(candidates[0]).sort(), [
    'conversationUrl', 'leadName', 'rowId', 'unreadCount',
  ]);
  assert.doesNotMatch(JSON.stringify(candidates), /preview|content|Private|group|Sponsored|Automated/i);
});

browserTest('openConversation prefers a validated direct URL and uses only the exact unread row as fallback', async (page) => {
  const unreadUrl = 'https://www.linkedin.com/messaging/?filter=unread';
  const fixture = await fs.readFile(path.join(fixtures, 'unread-candidates.html'), 'utf8');
  await page.route('https://www.linkedin.com/messaging/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/messaging/thread/')) {
      await route.fulfill({
        contentType: 'text/html',
        body: '<section class="msg-thread">Thread loaded</section>',
      });
      return;
    }
    await route.fulfill({ contentType: 'text/html', body: fixture });
  });
  const adapter = new PlaywrightLinkedInAdapter(page, {
    recoveryOptions: { pollIntervalMs: 10 },
  });
  await adapter.gotoUnread(unreadUrl);
  const candidates = await adapter.readUnreadCandidates();

  await adapter.openConversation(candidates[0]);
  assert.equal(page.url(), 'https://www.linkedin.com/messaging/thread/thread-1/');

  await adapter.openConversation({ conversationUrl: candidates[0].conversationUrl });
  assert.equal(page.url(), 'https://www.linkedin.com/messaging/thread/thread-1/');

  await adapter.gotoUnread(unreadUrl);
  await adapter.openConversation(candidates[1]);
  assert.match(page.url(), /\/messaging\/thread\/thread-2\/$/);
});

browserTest('anchorless opening fails closed unless exactly one visible matching row is still unread', async (page) => {
  await page.setContent(`
    <ul data-reporter-conversation-list>
      <li data-reporter-row-id="human-2"><h3>Read now</h3></li>
      <li data-reporter-row-id="human-2" class="msg-conversation-listitem--unread" style="display:none">
        <h3>Hidden stale duplicate</h3><span aria-label="1 unread message"></span>
      </li>
    </ul>
  `);
  const adapter = new PlaywrightLinkedInAdapter(page);

  await assert.rejects(
    adapter.openConversation({ rowId: 'human-2', conversationUrl: null }),
    ScanInvariantError,
  );
  assert.equal(page.url(), 'about:blank');
});

browserTest('direct opening fails closed when navigation lands on a different valid thread', async (page) => {
  const requestedUrl = 'https://www.linkedin.com/messaging/thread/requested-thread/';
  const wrongUrl = 'https://www.linkedin.com/messaging/thread/wrong-private-thread/';
  await page.route(requestedUrl, async (route) => route.fulfill({
    contentType: 'text/html',
    body: `
      <script>history.replaceState({}, '', '/messaging/thread/wrong-private-thread/')</script>
      <section class="msg-thread">Wrong thread loaded</section>
    `,
  }));
  const adapter = new PlaywrightLinkedInAdapter(page, {
    authTimeoutMs: 1_000,
    recoveryOptions: { pollIntervalMs: 10 },
  });

  await assert.rejects(
    adapter.openConversation({ conversationUrl: requestedUrl }),
    (error) => error instanceof ScanInvariantError
      && !error.message.includes(requestedUrl)
      && !error.message.includes(wrongUrl)
      && !error.message.includes('wrong-private-thread'),
  );
});

browserTest('Playwright adapter detects an active nested conversation container', async (page) => {
  await page.setContent(`
    <button aria-pressed="true">Unread</button>
    <ul aria-label="Conversation List" class="msg-conversations-container__conversations-list">
      <li class="msg-conversation-listitem">
        <div class="msg-conversation-card__convo-item-container--active"><h3>Opened</h3></div>
      </li>
    </ul>
  `);
  const adapter = new PlaywrightLinkedInAdapter(page);
  assert.equal((await adapter.inspectState()).activeRowCount, 1);
});

browserTest('an unread row without a stable identity fails closed', async (page) => {
  await page.setContent(`
    <li class="msg-conversation-listitem">
      <h3>Same Person</h3><p data-preview>Private first preview</p>
      <span aria-label="1 unread message"></span>
    </li>
  `);
  const adapter = new PlaywrightLinkedInAdapter(page);
  await assert.rejects(adapter.readRows(), ScanInvariantError);
});

browserTest('load-more control fails closed if it is nested in a conversation row', async (page) => {
  await page.setContent(`
    <li class="msg-conversation-listitem">
      <h3>Unsafe row</h3><button>Load more conversations</button>
    </li>
  `);
  const adapter = new PlaywrightLinkedInAdapter(page);
  await assert.rejects(adapter.hasLoadMore(), ScanInvariantError);
});

browserTest('hidden stale inbox markup cannot satisfy visible invariants or supply rows', async (page) => {
  await page.setContent(`
    <section style="display:none">
      <button aria-pressed="true">Unread</button>
      <ul class="msg-conversations-container__conversations-list">
        <li id="hidden" class="msg-conversation-listitem"><h3>Hidden stale name</h3><span aria-label="1 unread message"></span></li>
      </ul>
    </section>
    <button aria-pressed="false">Unread</button>
    <ul class="msg-conversations-container__conversations-list">
      <li id="visible" class="msg-conversation-listitem"><h3>Visible row</h3></li>
    </ul>
  `);
  const adapter = new PlaywrightLinkedInAdapter(page);
  const state = await adapter.inspectState();
  assert.equal(state.unreadFilterPressed, false);
  assert.equal(state.conversationListCount, 1);
  assert.deepEqual((await adapter.readRows()).map(({ id }) => id), ['visible']);
});

browserTest('hidden rows inside the visible inbox are not extracted', async (page) => {
  await page.setContent(`
    <button aria-pressed="true">Unread</button>
    <ul class="msg-conversations-container__conversations-list">
      <li id="hidden" class="msg-conversation-listitem" style="display:none">
        <h3>Hidden stale name</h3><span aria-label="1 unread message"></span>
      </li>
      <li id="visible" class="msg-conversation-listitem">
        <h3>Visible name</h3><span aria-label="1 unread message"></span>
      </li>
    </ul>
  `);
  const adapter = new PlaywrightLinkedInAdapter(page);
  assert.deepEqual((await adapter.readRows()).map(({ id }) => id), ['visible']);
});

browserTest('hidden CAPTCHA elements do not block a ready unread inbox', async (page) => {
  await page.setContent(`
    <button aria-pressed="true">Unread</button>
    <ul class="msg-conversations-container__conversations-list" style="width:100px;height:20px"></ul>
    <iframe src="about:blank?captcha" style="display:none"></iframe>
    <div data-test="captcha-container" hidden></div>
    <form action="/checkpoint/verify" style="display:none"></form>
    <input name="verification-code" hidden>
  `);
  const notices = [];
  let clock = 0;
  const adapter = new PlaywrightLinkedInAdapter(page, {
    onBlocker: ({ type }) => notices.push(type),
  });

  const result = await adapter.waitForUnblocked(100, {
    pollIntervalMs: 10,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
  });

  assert.deepEqual(result, { recovered: false });
  assert.deepEqual(notices, []);
});

browserTest('a visible CAPTCHA still blocks a ready unread inbox', async (page) => {
  await page.setContent(`
    <button aria-pressed="true">Unread</button>
    <ul class="msg-conversations-container__conversations-list" style="width:100px;height:20px"></ul>
    <div data-test="captcha-container" style="width:20px;height:20px"></div>
  `);
  const notices = [];
  let clock = 0;
  const adapter = new PlaywrightLinkedInAdapter(page, {
    onBlocker: ({ type }) => notices.push(type),
  });

  await assert.rejects(
    adapter.waitForUnblocked(20, {
      pollIntervalMs: 20,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
    }),
    (error) => error instanceof LinkedInBlockerError && error.type === 'captcha',
  );
  assert.deepEqual(notices, ['captcha']);
});

browserTest('a visible challenge still blocks a ready unread inbox', async (page) => {
  await page.setContent(`
    <button aria-pressed="true">Unread</button>
    <ul class="msg-conversations-container__conversations-list" style="width:100px;height:20px"></ul>
    <form action="/checkpoint/verify" style="width:20px;height:20px"></form>
  `);
  const notices = [];
  let clock = 0;
  const adapter = new PlaywrightLinkedInAdapter(page, {
    onBlocker: ({ type }) => notices.push(type),
  });

  await assert.rejects(
    adapter.waitForUnblocked(20, {
      pollIntervalMs: 20,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
    }),
    (error) => error instanceof LinkedInBlockerError && error.type === 'challenge',
  );
  assert.deepEqual(notices, ['challenge']);
});

browserTest('scrolling fails closed if the visible inbox loses uniqueness', async (page) => {
  await page.setContent(`
    <ul class="msg-conversations-container__conversations-list">
      <li id="visible" class="msg-conversation-listitem"><h3>Visible name</h3></li>
    </ul>
  `);
  await page.evaluate(() => {
    window.setTimeout(() => {
      const duplicate = document.querySelector('ul').cloneNode(true);
      duplicate.id = 'duplicate-list';
      document.body.append(duplicate);
    }, 50);
  });
  const adapter = new PlaywrightLinkedInAdapter(page);
  await assert.rejects(adapter.scrollList(), ScanInvariantError);
});
