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
    <ul aria-label="Conversation List">
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
