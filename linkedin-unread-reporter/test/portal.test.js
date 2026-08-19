import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConfigError,
  loadConfig,
  validatePortalCallSecret,
  validatePortalUrl,
} from '../src/config.js';
import {
  deliverReadyEntries,
  PortalDeliveryError,
  postPortalBatch,
} from '../src/portal.js';

const webhookUrl = 'https://portal.example.test/hooks/linkedin';
const callSecret = 'private-call-secret';
const capturedAt = new Date('2026-08-19T03:00:00.000Z');

function readyEntry({
  entryId = 'entry-created',
  idempotencyKey = 'created-key',
  linkedinMessageId = 'message-created',
  content = 'Private message content',
} = {}) {
  return {
    entryId,
    state: 'ready',
    idempotencyKey,
    linkedinMessageId,
    leadName: 'Private Lead',
    contentType: 'text',
    content,
    sentAt: '2026-08-19T02:00:00.000Z',
    sentAtRaw: '1h',
    sentAtAccuracy: 'estimated',
    conversationUrl: 'https://www.linkedin.com/messaging/thread/private-thread/',
  };
}

function portalMessage(overrides = {}) {
  const { entryId: _entryId, state: _state, ...message } = readyEntry(overrides);
  return message;
}

const capturePending = {
  entryId: 'entry-pending',
  state: 'capture_pending',
  leadName: 'Pending Lead',
  conversationUrl: 'https://www.linkedin.com/messaging/thread/pending-thread/',
  expectedUnreadCount: 1,
  firstFailureAt: '2026-08-19T03:00:00.000Z',
  attemptCount: 1,
};

test('configuration and delivery share the same portal credential contract without leaking', async () => {
  const safeCredentials = [
    [webhookUrl, callSecret],
    ['https://portal.example.test:8443/hooks/linkedin?tenant=one', 'token=part=='],
  ];
  for (const [portalWebhookUrl, portalCallSecret] of safeCredentials) {
    assert.equal(validatePortalUrl(portalWebhookUrl), new URL(portalWebhookUrl).toString());
    assert.equal(validatePortalCallSecret(portalCallSecret), portalCallSecret);
    assert.doesNotThrow(() => loadConfig({
      env: { PORTAL_WEBHOOK_URL: portalWebhookUrl, PORTAL_CALL_SECRET: portalCallSecret },
      requirePortal: true,
    }));
    await postPortalBatch({
      webhookUrl: portalWebhookUrl,
      callSecret: portalCallSecret,
      messages: [portalMessage()],
      capturedAt,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) }),
    });
  }

  const unsafeCredentials = [
    ['http://portal.example.test/private', callSecret],
    ['https://user:private@portal.example.test/hooks', callSecret],
    [`${webhookUrl}\nprivate`, callSecret],
    [webhookUrl, ''],
    [webhookUrl, 'private\nsecret'],
    [webhookUrl, 'private secret'],
  ];
  let deliveryCalls = 0;
  for (const [portalWebhookUrl, portalCallSecret] of unsafeCredentials) {
    const privateValues = [portalWebhookUrl, portalCallSecret].filter(Boolean);
    assert.throws(() => loadConfig({
      env: { PORTAL_WEBHOOK_URL: portalWebhookUrl, PORTAL_CALL_SECRET: portalCallSecret },
      requirePortal: true,
    }), (error) => {
      assert.ok(error instanceof ConfigError);
      for (const value of privateValues) assert.doesNotMatch(error.message, new RegExp(value));
      return true;
    });
    await assert.rejects(postPortalBatch({
      webhookUrl: portalWebhookUrl,
      callSecret: portalCallSecret,
      messages: [portalMessage()],
      capturedAt,
      fetchImpl: async () => { deliveryCalls += 1; },
    }), (error) => {
      assert.ok(error instanceof PortalDeliveryError);
      for (const value of privateValues) assert.doesNotMatch(error.message, new RegExp(value));
      return true;
    });
  }
  assert.equal(deliveryCalls, 0);
});

test('postPortalBatch sends one authenticated versioned batch', async () => {
  const requests = [];
  const result = await postPortalBatch({
    webhookUrl,
    callSecret,
    messages: [portalMessage()],
    capturedAt,
    fetchImpl: async (...request) => {
      requests.push(request);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [{ idempotencyKey: 'created-key', status: 'created', private: 'discard-me' }],
          private: 'discard-me-too',
        }),
      };
    },
  });

  assert.equal(requests.length, 1);
  const [url, request] = requests[0];
  const body = JSON.parse(request.body);
  assert.equal(url, webhookUrl);
  assert.equal(request.method, 'POST');
  assert.equal(request.redirect, 'error');
  assert.deepEqual(request.headers, {
    'content-type': 'application/json',
    'X-Portal-Call-Secret': callSecret,
  });
  assert.ok(request.signal instanceof AbortSignal);
  assert.equal(body.schemaVersion, '1');
  assert.match(body.batchId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(body.capturedAt, capturedAt.toISOString());
  assert.deepEqual(body.messages, [portalMessage()]);
  assert.equal(body.messages[0].status, undefined);
  assert.equal(body.messages[0].source, undefined);
  assert.deepEqual(result, {
    results: [{ idempotencyKey: 'created-key', status: 'created' }],
  });
  assert.doesNotMatch(JSON.stringify(result), /discard-me/);
});

test('postPortalBatch rejects unsafe URLs, invalid inputs, and duplicate request keys before HTTP', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; };
  const duplicateMessages = [
    portalMessage(),
    portalMessage({ entryId: 'entry-other', linkedinMessageId: 'message-other' }),
  ];
  const cases = [
    { webhookUrl: 'http://portal.example.test/private', callSecret, messages: [portalMessage()] },
    { webhookUrl: 'https://user:private@portal.example.test/hooks', callSecret, messages: [portalMessage()] },
    { webhookUrl, callSecret: 'private\nsecret', messages: [portalMessage()] },
    { webhookUrl, callSecret, messages: duplicateMessages },
    { webhookUrl, callSecret, messages: [{ ...portalMessage(), status: 'unread' }] },
    { webhookUrl, callSecret, messages: [{ ...portalMessage(), source: 'private-account' }] },
  ];

  for (const options of cases) {
    await assert.rejects(
      postPortalBatch({ ...options, capturedAt, fetchImpl }),
      (error) => error instanceof PortalDeliveryError
        && !error.message.includes('private')
        && !error.message.includes(callSecret),
    );
  }
  assert.equal(calls, 0);
});

test('postPortalBatch reports sanitized network errors and timeouts', async () => {
  const privateValues = [callSecret, webhookUrl, 'Private Lead', 'Private message content'];
  await assert.rejects(postPortalBatch({
    webhookUrl,
    callSecret,
    messages: [portalMessage()],
    capturedAt,
    fetchImpl: async () => {
      throw new Error(privateValues.join(' '));
    },
  }), (error) => {
    assert.ok(error instanceof PortalDeliveryError);
    assert.match(error.message, /network/i);
    for (const value of privateValues) assert.doesNotMatch(error.message, new RegExp(value));
    return true;
  });

  await assert.rejects(postPortalBatch({
    webhookUrl,
    callSecret,
    messages: [portalMessage()],
    capturedAt,
    timeoutMs: 1,
    fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error(privateValues.join(' '))), { once: true });
    }),
  }), (error) => {
    assert.ok(error instanceof PortalDeliveryError);
    assert.match(error.message, /timed out/i);
    for (const value of privateValues) assert.doesNotMatch(error.message, new RegExp(value));
    return true;
  });
});

test('postPortalBatch enforces its timeout even when the injected transport ignores abort', async () => {
  await assert.rejects(postPortalBatch({
    webhookUrl,
    callSecret,
    messages: [portalMessage()],
    capturedAt,
    timeoutMs: 1,
    fetchImpl: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    },
  }), (error) => error instanceof PortalDeliveryError && /timed out/i.test(error.message));
});

test('postPortalBatch reports only non-2xx status categories and never reads their bodies', async () => {
  for (const [status, category] of [[403, '4xx'], [503, '5xx'], [302, 'unexpected-status']]) {
    await assert.rejects(postPortalBatch({
      webhookUrl,
      callSecret,
      messages: [portalMessage()],
      capturedAt,
      fetchImpl: async () => ({
        ok: false,
        status,
        json: async () => { throw new Error('Private response body'); },
        text: async () => { throw new Error('Private response body'); },
      }),
    }), (error) => error instanceof PortalDeliveryError
      && error.message.includes(category)
      && !error.message.includes('Private'));
  }
});

test('postPortalBatch treats malformed 2xx JSON as sanitized malformed acknowledgement data', async () => {
  const result = await postPortalBatch({
    webhookUrl,
    callSecret,
    messages: [portalMessage()],
    capturedAt,
    fetchImpl: async () => ({
      ok: false,
      status: 204,
      json: async () => { throw new Error('Private response body'); },
    }),
  });
  assert.deepEqual(result, { results: null });
});

test('deliverReadyEntries projects ready entries without status or source and removes all on 2xx', async () => {
  const outbox = {
    version: 1,
    entries: [
      capturePending,
      readyEntry(),
      readyEntry({
        entryId: 'entry-duplicate',
        idempotencyKey: 'duplicate-key',
        linkedinMessageId: null,
      }),
      readyEntry({
        entryId: 'entry-missing',
        idempotencyKey: 'missing-key',
        linkedinMessageId: 'message-missing',
      }),
      readyEntry({
        entryId: 'entry-unknown',
        idempotencyKey: 'unknown-key',
        linkedinMessageId: 'message-unknown',
      }),
    ],
  };
  const before = structuredClone(outbox);
  let submitted;
  const result = await deliverReadyEntries({
    outbox,
    capturedAt,
    postBatch: async (request) => {
      submitted = request;
      return {
        results: [
          { idempotencyKey: 'created-key', status: 'created' },
          { idempotencyKey: 'duplicate-key', status: 'duplicate' },
          { idempotencyKey: 'unknown-key', status: 'private-unknown-status' },
          { malformed: true },
        ],
      };
    },
  });

  assert.deepEqual(outbox, before);
  assert.equal(submitted.capturedAt, capturedAt);
  assert.equal(submitted.messages.length, 4);
  assert.deepEqual(Object.keys(submitted.messages[0]).sort(), [
    'content', 'contentType', 'conversationUrl', 'idempotencyKey', 'leadName',
    'linkedinMessageId', 'sentAt', 'sentAtAccuracy', 'sentAtRaw',
  ]);
  assert.equal(submitted.messages[0].state, undefined);
  assert.equal(submitted.messages[0].entryId, undefined);
  assert.deepEqual(result, {
    outbox: { version: 1, entries: [capturePending] },
    counts: { created: 1, duplicate: 1, assumedDuplicate: 2 },
  });
});

test('deliverReadyEntries treats malformed results and duplicate acknowledgements as assumed duplicates', async () => {
  const outbox = { version: 1, entries: [readyEntry()] };
  for (const acknowledgement of [
    null,
    {},
    { results: null },
    { results: [{ idempotencyKey: 'created-key', status: 'created' }, { idempotencyKey: 'created-key', status: 'created' }] },
  ]) {
    const result = await deliverReadyEntries({
      outbox,
      postBatch: async () => acknowledgement,
      capturedAt,
    });
    assert.deepEqual(result.counts, { created: 0, duplicate: 0, assumedDuplicate: 1 });
    assert.deepEqual(result.outbox.entries, []);
  }
});

test('deliverReadyEntries leaves the caller outbox unchanged when delivery fails', async () => {
  const outbox = { version: 1, entries: [capturePending, readyEntry()] };
  const before = structuredClone(outbox);
  const failure = new PortalDeliveryError('Portal delivery failed (network).');
  await assert.rejects(deliverReadyEntries({
    outbox,
    postBatch: async () => { throw failure; },
    capturedAt,
  }), (error) => error === failure);
  assert.deepEqual(outbox, before);
});

test('deliverReadyEntries validates outbox shape and unique request keys without mutation or HTTP', async () => {
  let calls = 0;
  const duplicate = readyEntry({ entryId: 'entry-duplicate', linkedinMessageId: 'message-other' });
  const outbox = { version: 1, entries: [readyEntry(), duplicate] };
  const before = structuredClone(outbox);
  await assert.rejects(deliverReadyEntries({
    outbox,
    postBatch: async () => { calls += 1; },
    capturedAt,
  }), (error) => error instanceof PortalDeliveryError && /invalid/i.test(error.message));
  assert.equal(calls, 0);
  assert.deepEqual(outbox, before);
});

test('deliverReadyEntries makes no HTTP request when no entries are ready', async () => {
  const outbox = { version: 1, entries: [capturePending] };
  let calls = 0;
  const result = await deliverReadyEntries({
    outbox,
    postBatch: async () => { calls += 1; },
    capturedAt,
  });
  assert.equal(calls, 0);
  assert.deepEqual(result, {
    outbox,
    counts: { created: 0, duplicate: 0, assumedDuplicate: 0 },
  });
});
