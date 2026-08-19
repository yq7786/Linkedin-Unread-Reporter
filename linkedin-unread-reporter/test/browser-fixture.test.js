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
  let checkpointedUrl = null;
  await adapter.openConversation(candidates[1], {
    onOpened: async (url) => { checkpointedUrl = url; },
  });
  assert.match(page.url(), /\/messaging\/thread\/thread-2\/$/);
  assert.equal(checkpointedUrl, 'https://www.linkedin.com/messaging/thread/thread-2/');
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

browserTest('openConversation treats nested thread selectors as one visible thread', async (page) => {
  const url = 'https://www.linkedin.com/messaging/thread/nested-thread/';
  const fixture = await fs.readFile(path.join(fixtures, 'unread-thread-no-boundary.html'), 'utf8');
  await page.route(url, async (route) => route.fulfill({ contentType: 'text/html', body: fixture }));
  const adapter = new PlaywrightLinkedInAdapter(page, {
    authTimeoutMs: 1_000,
    recoveryOptions: { pollIntervalMs: 10 },
  });

  assert.equal(await adapter.openConversation({ conversationUrl: url }), url);
});

browserTest('readThreadMessages extracts visible direction, content type, id, and time metadata', async (page) => {
  const fixture = await fs.readFile(path.join(fixtures, 'unread-thread.html'), 'utf8');
  await page.route('https://www.linkedin.com/messaging/thread/thread-1/', async (route) => {
    await route.fulfill({ contentType: 'text/html', body: fixture });
  });
  await page.goto('https://www.linkedin.com/messaging/thread/thread-1/');
  const adapter = new PlaywrightLinkedInAdapter(page);

  const snapshot = await adapter.readThreadMessages();

  assert.equal(snapshot.conversationUrl, 'https://www.linkedin.com/messaging/thread/thread-1/');
  assert.equal(snapshot.unreadBoundaryIndex, 2);
  assert.equal(snapshot.messages.length, 5);
  assert.deepEqual(snapshot.messages[2], {
    linkedinMessageId: 'message-3',
    direction: 'inbound',
    contentType: 'text',
    content: 'Hello\nfrom LinkedIn 👋',
    sentAt: '2026-08-19T02:05:00.000Z',
    sentAtRaw: '11:35am',
  });
  assert.deepEqual(snapshot.messages[3], {
    linkedinMessageId: 'message-4',
    direction: 'outbound',
    contentType: 'text',
    content: 'Thanks!',
    sentAt: null,
    sentAtRaw: '5 min ago',
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /Hidden stale|Private ignored|Private image/);
});

browserTest('thread extraction records visible non-text labels without following links', async (page) => {
  const fixture = await fs.readFile(path.join(fixtures, 'unread-thread.html'), 'utf8');
  let downloadCalls = 0;
  page.on('download', () => { downloadCalls += 1; });
  await page.route('https://www.linkedin.com/messaging/thread/thread-1/', async (route) => {
    await route.fulfill({ contentType: 'text/html', body: fixture });
  });
  await page.goto('https://www.linkedin.com/messaging/thread/thread-1/');
  const adapter = new PlaywrightLinkedInAdapter(page);

  const snapshot = await adapter.readThreadMessages();

  assert.equal(snapshot.messages.at(-1).contentType, 'image');
  assert.equal(snapshot.messages.at(-1).content, 'Image attachment');
  assert.equal(snapshot.messages.at(-1).sentAt, null);
  assert.equal(snapshot.messages.at(-1).sentAtRaw, 'Today at 11:36 AM');
  assert.equal(downloadCalls, 0);
});

browserTest('thread extraction handles nested production selectors and prefers exact metadata', async (page) => {
  const fixture = await fs.readFile(path.join(fixtures, 'unread-thread-no-boundary.html'), 'utf8');
  await page.route('https://www.linkedin.com/messaging/thread/thread-2/', async (route) => {
    await route.fulfill({ contentType: 'text/html', body: fixture });
  });
  await page.goto('https://www.linkedin.com/messaging/thread/thread-2/');
  const adapter = new PlaywrightLinkedInAdapter(page);
  const expectedLocal = await page.evaluate(() => new Date(2026, 7, 19, 11, 40).toISOString());

  const snapshot = await adapter.readThreadMessages();

  assert.equal(snapshot.unreadBoundaryIndex, null);
  assert.deepEqual(snapshot.messages, [{
    linkedinMessageId: 'urn:li:msg_message:message-6',
    direction: 'inbound',
    contentType: 'text',
    content: 'Only visible message',
    sentAt: expectedLocal,
    sentAtRaw: 'August 19, 2026 at 11:40 AM',
  }]);
});

browserTest('thread extraction rejects impossible datetime metadata instead of normalizing it', async (page) => {
  const url = 'https://www.linkedin.com/messaging/thread/invalid-time/';
  await page.route(url, async (route) => route.fulfill({
    contentType: 'text/html',
    body: '<section class="msg-thread"><div data-reporter-message data-reporter-direction="inbound"><p data-reporter-content>Private message</p><time datetime="2026-02-30T02:05:00.000Z">Feb 30</time></div></section>',
  }));
  await page.goto(url);

  await assert.rejects(
    new PlaywrightLinkedInAdapter(page).readThreadMessages(),
    (error) => error instanceof ScanInvariantError
      && error.code === 'message-time-invalid'
      && !error.message.includes('Private message'),
  );
});

browserTest('thread extraction never inherits a generic thread id as message identity', async (page) => {
  const url = 'https://www.linkedin.com/messaging/thread/identity-scope/';
  await page.route(url, async (route) => route.fulfill({
    contentType: 'text/html',
    body: `
      <section class="msg-thread" id="private-thread-dom-id">
        <div data-reporter-message data-reporter-direction="inbound">
          <p data-reporter-content>First message without an id</p>
          <time datetime="2026-08-19T01:00:00.000Z">10:30am</time>
        </div>
        <div data-reporter-message data-reporter-direction="inbound">
          <p data-reporter-content>Second message without an id</p>
          <time datetime="2026-08-19T01:01:00.000Z">10:31am</time>
        </div>
      </section>
    `,
  }));
  await page.goto(url);

  const snapshot = await new PlaywrightLinkedInAdapter(page).readThreadMessages();

  assert.deepEqual(snapshot.messages.map(({ linkedinMessageId }) => linkedinMessageId), [null, null]);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-thread-dom-id/);
});

browserTest('thread extraction normalizes exact title and aria timestamps in browser local time', async (page) => {
  const url = 'https://www.linkedin.com/messaging/thread/exact-labels/';
  await page.route(url, async (route) => route.fulfill({
    contentType: 'text/html',
    body: `
      <section class="msg-thread">
        <div data-reporter-message data-reporter-direction="inbound">
          <p data-reporter-content>Exact aria wins</p>
          <time title="5 min ago" aria-label="August 19, 2026 at 11:40 AM">Now</time>
        </div>
        <div data-reporter-message data-reporter-direction="outbound">
          <p data-reporter-content>Exact ISO title</p>
          <time title="2026-08-19T02:15:00.000Z">1 min ago</time>
        </div>
      </section>
    `,
  }));
  await page.goto(url);
  const expectedLocal = await page.evaluate(() => new Date(2026, 7, 19, 11, 40).toISOString());

  const snapshot = await new PlaywrightLinkedInAdapter(page).readThreadMessages();

  assert.equal(snapshot.messages[0].sentAt, expectedLocal);
  assert.equal(snapshot.messages[0].sentAtRaw, 'August 19, 2026 at 11:40 AM');
  assert.equal(snapshot.messages[1].sentAt, '2026-08-19T02:15:00.000Z');
  assert.equal(snapshot.messages[1].sentAtRaw, '2026-08-19T02:15:00.000Z');
});

browserTest('thread extraction hovers only its timestamp to resolve one exact tooltip', async (page) => {
  const url = 'https://www.linkedin.com/messaging/thread/tooltip-time/';
  const fixture = await fs.readFile(path.join(fixtures, 'unread-thread-tooltip.html'), 'utf8');
  await page.route(url, async (route) => route.fulfill({ contentType: 'text/html', body: fixture }));
  await page.goto(url);
  const expectedLocal = await page.evaluate(() => new Date(2026, 7, 19, 11, 40).toISOString());

  const snapshot = await new PlaywrightLinkedInAdapter(page).readThreadMessages();

  assert.equal(snapshot.messages[0].sentAt, expectedLocal);
  assert.equal(snapshot.messages[0].sentAtRaw, 'August 19, 2026 at 11:40 AM');
  assert.equal(await page.evaluate(() => window.timestampHoverCalls), 1);
  assert.equal(await page.evaluate(() => window.timestampClickCalls || 0), 0);
});

browserTest('thread extraction labels production non-text messages without activating attachments', async (page) => {
  const url = 'https://www.linkedin.com/messaging/thread/non-text/';
  let downloadCalls = 0;
  page.on('download', () => { downloadCalls += 1; });
  await page.route(url, async (route) => route.fulfill({
    contentType: 'text/html',
    body: `
      <section class="msg-thread">
        <div data-reporter-message data-reporter-direction="inbound"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" alt="Profile screenshot"></div>
        <div data-reporter-message data-reporter-direction="inbound"><div class="msg-s-event-listitem__file-attachment"><a href="https://www.linkedin.com/attachment/private" download onclick="window.attachmentClicks = (window.attachmentClicks || 0) + 1">Project brief.pdf</a></div></div>
        <div data-reporter-message data-reporter-direction="inbound"><div class="msg-s-event-listitem__voice-message" aria-label="Voice message">Voice message</div></div>
        <div data-reporter-message data-reporter-direction="outbound"><article class="msg-s-event-listitem__shared-post" aria-label="Shared post"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" alt="Post preview">Shared post</article></div>
      </section>
    `,
  }));
  await page.goto(url);

  const snapshot = await new PlaywrightLinkedInAdapter(page).readThreadMessages();

  assert.deepEqual(snapshot.messages.map(({ contentType, content }) => ({ contentType, content })), [
    { contentType: 'image', content: 'Profile screenshot' },
    { contentType: 'file', content: 'Project brief.pdf' },
    { contentType: 'audio', content: 'Voice message' },
    { contentType: 'shared_post', content: 'Shared post' },
  ]);
  assert.equal(await page.evaluate(() => window.attachmentClicks || 0), 0);
  assert.equal(downloadCalls, 0);
  assert.equal(page.url(), url);
});

browserTest('thread extraction does not mistake a visible sender avatar for message content', async (page) => {
  const url = 'https://www.linkedin.com/messaging/thread/text-with-avatar/';
  await page.route(url, async (route) => route.fulfill({
    contentType: 'text/html',
    body: `
      <section class="msg-thread">
        <div data-reporter-message data-reporter-direction="inbound">
          <img class="msg-s-event-listitem__profile-picture" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" alt="Private sender avatar">
          <p data-reporter-content>Visible text remains canonical</p>
        </div>
      </section>
    `,
  }));
  await page.goto(url);

  const snapshot = await new PlaywrightLinkedInAdapter(page).readThreadMessages();

  assert.equal(snapshot.messages[0].contentType, 'text');
  assert.equal(snapshot.messages[0].content, 'Visible text remains canonical');
  assert.doesNotMatch(JSON.stringify(snapshot), /Private sender avatar/);
});

browserTest('thread extraction fails closed when an unread thread has no canonical visible messages', async (page) => {
  const url = 'https://www.linkedin.com/messaging/thread/empty-drift/';
  await page.route(url, async (route) => route.fulfill({
    contentType: 'text/html',
    body: '<section class="msg-thread"><div data-reporter-unread-divider>Unread</div><div data-reporter-message data-reporter-direction="inbound" style="display:none"><p data-reporter-content>Private hidden stale</p></div></section>',
  }));
  await page.goto(url);

  await assert.rejects(
    new PlaywrightLinkedInAdapter(page).readThreadMessages(),
    (error) => error instanceof ScanInvariantError
      && error.code === 'message-list-missing'
      && !error.message.includes('Private hidden stale'),
  );
});

browserTest('thread extraction fails closed with sanitized errors on unsafe DOM or URL state', async (page) => {
  const cases = [
    {
      code: 'conversation-thread-not-uniquely-visible',
      html: '<section class="msg-thread">one</section><section class="msg-thread">two</section>',
    },
    {
      code: 'message-direction-ambiguous',
      html: '<section class="msg-thread"><div data-reporter-message data-reporter-direction="inbound" class="msg-s-event-listitem--from-me"><p data-reporter-content>Private ambiguous</p></div></section>',
    },
    {
      code: 'message-content-missing',
      html: '<section class="msg-thread"><div data-reporter-message data-reporter-direction="inbound"><span>Private untyped fallback</span></div></section>',
    },
  ];

  for (const [index, fixtureCase] of cases.entries()) {
    const url = `https://www.linkedin.com/messaging/thread/failure-${index}/`;
    await page.route(url, async (route) => route.fulfill({ contentType: 'text/html', body: fixtureCase.html }));
    await page.goto(url);
    const adapter = new PlaywrightLinkedInAdapter(page);
    await assert.rejects(adapter.readThreadMessages(), (error) => (
      error instanceof ScanInvariantError
        && error.code === fixtureCase.code
        && !error.message.includes('Private')
        && !error.message.includes(url)
    ));
  }

  await page.goto('about:blank');
  await page.setContent('<section class="msg-thread"><div data-reporter-message data-reporter-direction="inbound"><p data-reporter-content>Private content</p></div></section>');
  await assert.rejects(new PlaywrightLinkedInAdapter(page).readThreadMessages(), (error) => (
    error.code === 'conversation-url-invalid' && !error.message.includes('Private content')
  ));
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
