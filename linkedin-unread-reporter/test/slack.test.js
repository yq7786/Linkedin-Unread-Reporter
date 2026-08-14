import assert from 'node:assert/strict';
import test from 'node:test';

import { postSlackReport, SlackDeliveryError } from '../src/slack.js';

const webhookUrl = ['https://hooks.slack.com', 'services', 'AAA', 'BBB', 'CCC'].join('/');

test('postSlackReport sends a JSON text payload', async () => {
  const calls = [];
  const result = await postSlackReport({
    webhookUrl,
    text: 'LinkedIn unread message: 0',
    fetchImpl: async (...args) => {
      calls.push(args);
      return { ok: true, status: 200 };
    },
  });

  assert.deepEqual(result, { delivered: true, status: 200 });
  assert.equal(calls[0][0], webhookUrl);
  assert.deepEqual(calls[0][1], {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ text: 'LinkedIn unread message: 0' }),
    signal: calls[0][1].signal,
  });
  assert.ok(calls[0][1].signal instanceof AbortSignal);
});

test('postSlackReport reports only a sanitized HTTP category', async () => {
  await assert.rejects(
    postSlackReport({
      webhookUrl,
      text: 'test',
      fetchImpl: async () => ({ ok: false, status: 403 }),
    }),
    (error) => error instanceof SlackDeliveryError
      && /4xx/.test(error.message)
      && !error.message.includes(webhookUrl),
  );
});

test('postSlackReport sanitizes network errors that contain the webhook', async () => {
  await assert.rejects(
    postSlackReport({
      webhookUrl,
      text: 'test',
      fetchImpl: async () => { throw new Error(`connect failed ${webhookUrl}`); },
    }),
    (error) => error instanceof SlackDeliveryError
      && error.message.includes('[REDACTED_SLACK_WEBHOOK]')
      && !error.message.includes(webhookUrl),
  );
});
