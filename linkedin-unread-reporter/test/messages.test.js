import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createIdempotencyKey,
  normalizeLeadName,
  normalizeIsoTimestamp,
  normalizeVisibleText,
  selectUnreadInboundMessages,
  validateConversationUrl,
} from '../src/messages.js';

test('normalizeIsoTimestamp requires and canonicalizes a valid ISO timestamp', () => {
  assert.equal(
    normalizeIsoTimestamp('2026-08-19T12:05:00+10:00'),
    '2026-08-19T02:05:00.000Z',
  );
  for (const value of [
    null,
    42,
    'August 19, 2026',
    '2026-02-30T02:05:00Z',
    '2026-08-19T24:00:00Z',
  ]) {
    assert.throws(
      () => normalizeIsoTimestamp(value),
      (error) => error instanceof Error
        && error.name === 'MessageDataError'
        && error.code === 'sent-at-invalid',
    );
  }
});

test('validateConversationUrl accepts only LinkedIn thread URLs and returns the canonical URL', () => {
  const canonical = 'https://www.linkedin.com/messaging/thread/opaque-id/';

  assert.equal(validateConversationUrl('/messaging/thread/opaque-id/?filter=unread#latest'), canonical);
  assert.equal(validateConversationUrl(`${canonical}?filter=unread#latest`), canonical);

  for (const invalidUrl of [
    'https://evil.example/messaging/thread/opaque-id/',
    'http://www.linkedin.com/messaging/thread/opaque-id/',
    'https://linkedin.com/messaging/thread/opaque-id/',
    'https://user@www.linkedin.com/messaging/thread/opaque-id/',
    'https://www.linkedin.com/messaging/thread/opaque-id',
    'https://www.linkedin.com/messaging/thread/opaque/id/',
  ]) {
    assert.throws(
      () => validateConversationUrl(invalidUrl),
      (error) => error.name === 'MessageDataError'
        && error.code === 'conversation-url-invalid'
        && !error.message.includes(invalidUrl),
    );
  }
});

test('createIdempotencyKey prefers a message id and otherwise hashes a canonical stable fallback', () => {
  assert.equal(createIdempotencyKey({ linkedinMessageId: '  m-1  ' }), 'linkedin:m-1');

  const fallbackInput = {
    linkedinMessageId: null,
    leadName: 'Ada Lovelace',
    sentAt: '2026-08-19T02:05:00.000Z',
    conversationUrl: 'https://www.linkedin.com/messaging/thread/opaque-id/',
  };
  const key = createIdempotencyKey(fallbackInput);

  assert.match(key, /^sha256:[a-f0-9]{64}$/);
  assert.equal(key, createIdempotencyKey({
    ...fallbackInput,
    leadName: '  Ada   Lovelace ',
    conversationUrl: '/messaging/thread/opaque-id/?filter=unread#latest',
  }));
  assert.equal(key, createIdempotencyKey(fallbackInput));
});

test('createIdempotencyKey rejects invalid ISO timestamps without exposing input', () => {
  const privateTimestamp = 'private-timestamp';
  assert.throws(
    () => createIdempotencyKey({
      linkedinMessageId: null,
      leadName: 'Ada Lovelace',
      sentAt: privateTimestamp,
      conversationUrl: '/messaging/thread/opaque-id/',
    }),
    (error) => error.name === 'MessageDataError'
      && error.code === 'sent-at-invalid'
      && !error.message.includes(privateTimestamp),
  );
});

test('createIdempotencyKey canonicalizes equivalent ISO timestamp representations', () => {
  const fallbackInput = {
    linkedinMessageId: null,
    leadName: 'Ada Lovelace',
    conversationUrl: '/messaging/thread/opaque-id/',
  };

  assert.equal(
    createIdempotencyKey({ ...fallbackInput, sentAt: '2026-08-19T12:05:00+10:00' }),
    createIdempotencyKey({ ...fallbackInput, sentAt: '2026-08-19T02:05:00.000Z' }),
  );
});

test('createIdempotencyKey rejects impossible ISO calendar timestamps', () => {
  const impossibleTimestamp = '2026-02-30T02:05:00Z';
  assert.throws(
    () => createIdempotencyKey({
      linkedinMessageId: null,
      leadName: 'Ada Lovelace',
      sentAt: impossibleTimestamp,
      conversationUrl: '/messaging/thread/opaque-id/',
    }),
    (error) => error.name === 'MessageDataError'
      && error.code === 'sent-at-invalid'
      && !error.message.includes(impossibleTimestamp),
  );
});

test('normalizers canonicalize names while preserving visible line breaks and emojis', () => {
  assert.equal(normalizeLeadName('  Ada \n  Lovelace  '), 'Ada Lovelace');
  assert.equal(
    normalizeVisibleText('  Hello\r\nfrom  LinkedIn 👋\rThank you!  '),
    'Hello\nfrom  LinkedIn 👋\nThank you!',
  );
});

test('normalizers reject empty names and missing visible content with sanitized codes', () => {
  for (const value of ['', ' \n\t ', null, undefined]) {
    assert.throws(
      () => normalizeLeadName(value),
      (error) => error.name === 'MessageDataError'
        && error.code === 'lead-name-invalid'
        && error.message === 'lead-name-invalid',
    );
    assert.throws(
      () => normalizeVisibleText(value),
      (error) => error.name === 'MessageDataError'
        && error.code === 'visible-content-invalid'
        && error.message === 'visible-content-invalid',
    );
  }
});

test('normalizers reject coercible objects and numbers instead of creating string collisions', () => {
  const malformedValues = [{ private: 'first' }, { private: 'second' }, 0, 42];

  for (const value of malformedValues) {
    assert.throws(
      () => normalizeLeadName(value),
      (error) => error.name === 'MessageDataError'
        && error.code === 'lead-name-invalid'
        && error.message === 'lead-name-invalid',
    );
    assert.throws(
      () => normalizeVisibleText(value),
      (error) => error.name === 'MessageDataError'
        && error.code === 'visible-content-invalid'
        && error.message === 'visible-content-invalid',
    );
  }
});

test('createIdempotencyKey rejects malformed and blank LinkedIn message ids instead of colliding', () => {
  for (const linkedinMessageId of [{ private: 'first' }, { private: 'second' }, 0, 42, '   ']) {
    assert.throws(
      () => createIdempotencyKey({ linkedinMessageId }),
      (error) => error.name === 'MessageDataError'
        && error.code === 'message-id-invalid'
        && error.message === 'message-id-invalid',
    );
  }
});

test('createIdempotencyKey treats only nullish message ids as absent', () => {
  const fallbackInput = {
    leadName: 'Ada Lovelace',
    sentAt: '2026-08-19T02:05:00.000Z',
    conversationUrl: '/messaging/thread/opaque-id/',
  };

  assert.equal(
    createIdempotencyKey({ ...fallbackInput, linkedinMessageId: null }),
    createIdempotencyKey({ ...fallbackInput, linkedinMessageId: undefined }),
  );
});

test('selectUnreadInboundMessages applies boundary, then count, then newest inbound fallback', () => {
  const messages = [
    { direction: 'outbound', content: 'old' },
    { direction: 'inbound', content: 'first' },
    { direction: 'outbound', content: 'reply' },
    { direction: 'inbound', content: 'second\n👋' },
    { direction: 'inbound', content: 'third' },
  ];

  assert.deepEqual(
    selectUnreadInboundMessages({ messages, unreadBoundaryIndex: 1, expectedUnreadCount: 1 })
      .map((message) => message.content),
    ['first', 'second\n👋', 'third'],
  );
  assert.deepEqual(
    selectUnreadInboundMessages({ messages, expectedUnreadCount: 2 })
      .map((message) => message.content),
    ['second\n👋', 'third'],
  );
  assert.deepEqual(
    selectUnreadInboundMessages({ messages }).map((message) => message.content),
    ['third'],
  );
});

test('selectUnreadInboundMessages rejects invalid directions and missing visible labels safely', () => {
  assert.throws(
    () => selectUnreadInboundMessages({ messages: [{ direction: 'private-direction', content: 'private-content' }] }),
    (error) => error.code === 'message-direction-invalid'
      && !error.message.includes('private-direction')
      && !error.message.includes('private-content'),
  );
  assert.throws(
    () => selectUnreadInboundMessages({ messages: [{ direction: 'inbound', content: '   ' }] }),
    (error) => error.code === 'visible-content-invalid' && !error.message.includes('inbound'),
  );
});

test('selectUnreadInboundMessages rejects non-array messages and non-string content safely', () => {
  for (const messages of [{ private: 'messages' }, 42]) {
    assert.throws(
      () => selectUnreadInboundMessages({ messages }),
      (error) => error.name === 'MessageDataError'
        && error.code === 'messages-invalid'
        && error.message === 'messages-invalid',
    );
  }
  for (const content of [{ private: 'content' }, 42]) {
    assert.throws(
      () => selectUnreadInboundMessages({ messages: [{ direction: 'inbound', content }] }),
      (error) => error.name === 'MessageDataError'
        && error.code === 'visible-content-invalid'
        && error.message === 'visible-content-invalid',
    );
  }
});

test('selectUnreadInboundMessages rejects malformed provided boundaries instead of falling back', () => {
  const messages = [
    { direction: 'inbound', content: 'first' },
    { direction: 'inbound', content: 'second' },
  ];

  for (const unreadBoundaryIndex of [-1, 3, 0.5, '1']) {
    assert.throws(
      () => selectUnreadInboundMessages({ messages, unreadBoundaryIndex, expectedUnreadCount: 1 }),
      (error) => error.name === 'MessageDataError'
        && error.code === 'unread-boundary-invalid'
        && error.message === 'unread-boundary-invalid',
    );
  }
});

test('selectUnreadInboundMessages rejects malformed provided counts instead of falling back', () => {
  const messages = [
    { direction: 'outbound', content: 'reply' },
    { direction: 'inbound', content: 'first' },
    { direction: 'inbound', content: 'second' },
  ];

  for (const expectedUnreadCount of [0, -1, 3, 1.5, '1']) {
    assert.throws(
      () => selectUnreadInboundMessages({ messages, expectedUnreadCount }),
      (error) => error.name === 'MessageDataError'
        && error.code === 'unread-count-invalid'
        && error.message === 'unread-count-invalid',
    );
  }
});

test('selectUnreadInboundMessages treats only nullish hints as absent', () => {
  const messages = [
    { direction: 'inbound', content: 'first' },
    { direction: 'inbound', content: 'second' },
  ];

  assert.deepEqual(
    selectUnreadInboundMessages({ messages, unreadBoundaryIndex: null, expectedUnreadCount: null })
      .map((message) => message.content),
    ['second'],
  );
  assert.deepEqual(
    selectUnreadInboundMessages({ messages, unreadBoundaryIndex: messages.length })
      .map((message) => message.content),
    [],
  );
});
