import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertUnreadListInvariants,
  classifyBlocker,
  normalizeConversationRow,
  ScanInvariantError,
} from '../src/linkedin-state.js';

test('assertUnreadListInvariants accepts the safe unread-list state', () => {
  assert.doesNotThrow(() => assertUnreadListInvariants({
    unreadFilterPressed: true,
    conversationListPresent: true,
    conversationListCount: 1,
    activeRowCount: 0,
    detailPaneVisible: false,
  }));
});

for (const [label, state] of [
  ['unread filter not pressed', { unreadFilterPressed: false, conversationListPresent: true, conversationListCount: 1, activeRowCount: 0, detailPaneVisible: false }],
  ['conversation list missing', { unreadFilterPressed: true, conversationListPresent: false, conversationListCount: 0, activeRowCount: 0, detailPaneVisible: false }],
  ['conversation list ambiguous', { unreadFilterPressed: true, conversationListPresent: false, conversationListCount: 2, activeRowCount: 0, detailPaneVisible: false }],
  ['active row', { unreadFilterPressed: true, conversationListPresent: true, conversationListCount: 1, activeRowCount: 1, detailPaneVisible: false }],
  ['detail pane', { unreadFilterPressed: true, conversationListPresent: true, conversationListCount: 1, activeRowCount: 0, detailPaneVisible: true }],
]) {
  test(`assertUnreadListInvariants fails closed for ${label}`, () => {
    assert.throws(() => assertUnreadListInvariants(state), ScanInvariantError);
  });
}

test('normalizeConversationRow keeps only explicit unread eligible names', () => {
  assert.deepEqual(normalizeConversationRow({
    id: 'row-1',
    name: '  Ada   Lovelace  ',
    unread: true,
    labels: ['Unread message'],
  }), { id: 'row-1', name: 'Ada Lovelace' });
  assert.equal(normalizeConversationRow({ id: 'row-2', name: 'Read Person', unread: false }), null);
  assert.equal(normalizeConversationRow({ id: 'row-3', name: '', unread: true }), null);
});

test('normalizeConversationRow excludes explicit sponsored and automated labels only', () => {
  assert.equal(normalizeConversationRow({
    id: 'sponsored', name: 'Advertiser', unread: true, labels: ['Sponsored'],
  }), null);
  assert.equal(normalizeConversationRow({
    id: 'automated', name: 'System', unread: true, labels: ['Automated conversation'],
  }), null);
  assert.deepEqual(normalizeConversationRow({
    id: 'ordinary', name: 'Automation Expert', unread: true, labels: [],
  }), { id: 'ordinary', name: 'Automation Expert' });
});

test('classifyBlocker recognizes login, checkpoint, challenge, and captcha states', () => {
  assert.equal(classifyBlocker({ url: 'https://www.linkedin.com/login', title: '', bodyText: '' }), 'login');
  assert.equal(classifyBlocker({ url: 'https://www.linkedin.com/checkpoint/challenge/123', title: '', bodyText: '' }), 'checkpoint');
  assert.equal(classifyBlocker({ url: 'https://www.linkedin.com/messaging/', title: 'Security verification', bodyText: 'Quick security check' }), 'challenge');
  assert.equal(classifyBlocker({ url: 'https://www.linkedin.com/messaging/', title: '', bodyText: 'Complete the CAPTCHA' }), 'captcha');
  assert.equal(classifyBlocker({ url: 'https://www.linkedin.com/messaging/?filter=unread', title: 'Messaging', bodyText: '' }), null);
});
