import assert from 'node:assert/strict';
import test from 'node:test';

import { formatSlackReport, groupConversationNames } from '../src/report.js';

const inboxUrl = 'https://www.linkedin.com/messaging/?filter=unread';
const scannedAt = new Date('2026-08-14T02:30:00.000Z'); // 12:00pm Adelaide (ACST)

test('groupConversationNames preserves inbox order and exact duplicate counts', () => {
  assert.deepEqual(groupConversationNames([
    { name: 'Zoë' },
    { name: '李雷' },
    { name: 'Zoë' },
    { name: 'Zoe' },
  ]), ['Zoë — 2 conversations', '李雷', 'Zoe']);
});

test('formatSlackReport renders a normal report exactly', () => {
  const text = formatSlackReport({
    conversations: [{ name: 'Ada Lovelace' }, { name: 'Grace Hopper' }],
    truncated: false,
    scannedAt,
    timezone: 'Australia/Adelaide',
    inboxUrl,
  });

  assert.equal(text, [
    'LinkedIn unread message: 2',
    'Scanned: 12:00pm Australia/Adelaide',
    '',
    '• Ada Lovelace',
    '• Grace Hopper',
    '',
    `<${inboxUrl}|Open LinkedIn Unread Inbox>`,
  ].join('\n'));
});

test('formatSlackReport sends a useful zero report', () => {
  const text = formatSlackReport({
    conversations: [], truncated: false, scannedAt, timezone: 'Australia/Adelaide', inboxUrl,
  });
  assert.match(text, /^LinkedIn unread message: 0\n/);
  assert.doesNotMatch(text, /^•/m);
  assert.match(text, /Open LinkedIn Unread Inbox/);
});

test('formatSlackReport marks an early cap without changing the required prefix', () => {
  const conversations = Array.from({ length: 50 }, (_, index) => ({ name: `Person ${index}` }));
  const text = formatSlackReport({
    conversations, truncated: true, scannedAt, timezone: 'Australia/Adelaide', inboxUrl,
  });
  assert.match(text, /^LinkedIn unread message: 50\+/);
  assert.match(text, /Showing the first 50 unread conversations\./);
});

test('formatSlackReport escapes Slack markup in displayed names', () => {
  const text = formatSlackReport({
    conversations: [{ name: '<Admin & Co>' }],
    truncated: false,
    scannedAt,
    timezone: 'Australia/Adelaide',
    inboxUrl,
  });
  assert.match(text, /• &lt;Admin &amp; Co&gt;/);
  assert.doesNotMatch(text, /• <Admin/);
});
