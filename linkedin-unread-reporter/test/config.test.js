import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { ConfigError, loadConfig, parseEnvText, redactSecrets } from '../src/config.js';

const validWebhook = ['https://hooks.slack.com', 'services', 'AAA', 'BBB', 'CCC'].join('/');

test('loadConfig applies safe defaults relative to the project root', () => {
  const config = loadConfig({
    env: { SLACK_WEBHOOK_URL: validWebhook },
    projectRoot: '/tmp/reporter',
  });

  assert.equal(config.slackWebhookUrl, validWebhook);
  assert.equal(config.browserProfilePath, path.resolve('/tmp/reporter', '.linkedin-browser-profile'));
  assert.equal(config.unreadUrl, 'https://www.linkedin.com/messaging/?filter=unread');
  assert.equal(config.maxUnreadConversations, 50);
  assert.equal(config.authTimeoutMs, 900_000);
  assert.equal(config.reportTimezone, 'Australia/Adelaide');
});

test('loadConfig allows scan-only operation without a webhook', () => {
  const config = loadConfig({ env: {}, projectRoot: '/tmp/reporter', requireWebhook: false });
  assert.equal(config.slackWebhookUrl, null);
});

test('loadConfig rejects a missing webhook for publishing', () => {
  assert.throws(
    () => loadConfig({ env: {}, projectRoot: '/tmp/reporter' }),
    (error) => error instanceof ConfigError && /npm run configure/.test(error.message),
  );
});

test('loadConfig rejects invalid values without echoing them', () => {
  const secret = 'https://evil.invalid/private-secret';
  assert.throws(
    () => loadConfig({ env: { SLACK_WEBHOOK_URL: secret }, projectRoot: '/tmp/reporter' }),
    (error) => error instanceof ConfigError && !error.message.includes(secret),
  );
  assert.throws(
    () => loadConfig({
      env: { SLACK_WEBHOOK_URL: validWebhook, MAX_UNREAD_CONVERSATIONS: '0' },
      projectRoot: '/tmp/reporter',
    }),
    /MAX_UNREAD_CONVERSATIONS/,
  );
});

test('loadConfig validates the IANA timezone', () => {
  assert.throws(
    () => loadConfig({
      env: { SLACK_WEBHOOK_URL: validWebhook, REPORT_TIMEZONE: 'Mars/Olympus' },
      projectRoot: '/tmp/reporter',
    }),
    /REPORT_TIMEZONE/,
  );
});

test('parseEnvText handles comments, export syntax, quoting, and equals signs', () => {
  assert.deepEqual(parseEnvText([
    '# comment',
    'export FIRST=one',
    'SECOND="two words"',
    "THIRD='three=parts'",
    '',
  ].join('\n')), {
    FIRST: 'one',
    SECOND: 'two words',
    THIRD: 'three=parts',
  });
});

test('redactSecrets removes webhook-shaped values', () => {
  assert.equal(
    redactSecrets(`Request failed for ${validWebhook}`),
    'Request failed for [REDACTED_SLACK_WEBHOOK]',
  );
});
