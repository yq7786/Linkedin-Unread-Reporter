import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { PlaywrightLinkedInAdapter } from '../src/browser.js';
import { normalizeConversationRow, ScanInvariantError } from '../src/linkedin-state.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

test('Playwright adapter extracts only row metadata from the unread fixture', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
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

test('Playwright adapter detects an active nested conversation container', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
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

test('an unread row without a stable identity fails closed', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <li class="msg-conversation-listitem">
      <h3>Same Person</h3><p data-preview>Private first preview</p>
      <span aria-label="1 unread message"></span>
    </li>
  `);
  const adapter = new PlaywrightLinkedInAdapter(page);
  await assert.rejects(adapter.readRows(), ScanInvariantError);
});

test('load-more control fails closed if it is nested in a conversation row', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <li class="msg-conversation-listitem">
      <h3>Unsafe row</h3><button>Load more conversations</button>
    </li>
  `);
  const adapter = new PlaywrightLinkedInAdapter(page);
  await assert.rejects(adapter.hasLoadMore(), ScanInvariantError);
});

test('hidden stale inbox markup cannot satisfy visible invariants or supply rows', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
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

test('hidden rows inside the visible inbox are not extracted', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
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

test('scrolling fails closed if the visible inbox loses uniqueness', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
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
