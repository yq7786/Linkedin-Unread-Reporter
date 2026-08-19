import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { ConfigError, loadConfig, parseEnvText, redactSecrets } from '../src/config.js';

const validPortalUrl = 'https://portal.example.test/hooks/linkedin';
const validCallSecret = 'private-call-secret';
const validSlackWebhook = ['https://hooks.slack.com', 'services', 'AAA', 'BBB', 'CCC'].join('/');

test('loadConfig applies safe defaults relative to the project root', () => {
  const config = loadConfig({
    env: {
      PORTAL_WEBHOOK_URL: validPortalUrl,
      PORTAL_CALL_SECRET: validCallSecret,
    },
    projectRoot: '/tmp/reporter',
  });

  assert.equal(config.portalWebhookUrl, validPortalUrl);
  assert.equal(config.portalCallSecret, validCallSecret);
  assert.equal(config.browserProfilePath, path.resolve('/tmp/reporter', '.linkedin-browser-profile'));
  assert.equal(config.outboxPath, path.resolve('/tmp/reporter', '.linkedin-unread-outbox.json'));
  assert.equal(config.outboxLockPath, path.resolve('/tmp/reporter', '.linkedin-unread-outbox.lock'));
  assert.equal(config.timestampWorkPath, path.resolve('/tmp/reporter', '.linkedin-timestamp-work.json'));
  assert.equal(config.timestampResultPath, path.resolve('/tmp/reporter', '.linkedin-timestamp-results.json'));
  assert.equal(config.unreadUrl, 'https://www.linkedin.com/messaging/?filter=unread');
  assert.equal(config.maxUnreadConversations, 50);
  assert.equal(config.authTimeoutMs, 900_000);
  assert.equal(config.reportTimezone, 'Australia/Adelaide');
});

test('loadConfig allows scan-only operation without portal credentials', () => {
  const config = loadConfig({ env: {}, projectRoot: '/tmp/reporter', requirePortal: false });
  assert.equal(config.portalWebhookUrl, null);
  assert.equal(config.portalCallSecret, null);
});

test('loadConfig rejects missing portal credentials for delivery', () => {
  assert.throws(
    () => loadConfig({ env: {}, projectRoot: '/tmp/reporter' }),
    (error) => error instanceof ConfigError && /npm run configure/.test(error.message),
  );
});

test('loadConfig rejects invalid values without echoing them', () => {
  const secret = 'https://user:private-secret@portal.example.test/hooks/linkedin';
  assert.throws(
    () => loadConfig({
      env: { PORTAL_WEBHOOK_URL: secret, PORTAL_CALL_SECRET: validCallSecret },
      projectRoot: '/tmp/reporter',
    }),
    (error) => error instanceof ConfigError && !error.message.includes(secret),
  );
  assert.throws(
    () => loadConfig({
      env: {
        PORTAL_WEBHOOK_URL: validPortalUrl,
        PORTAL_CALL_SECRET: validCallSecret,
        MAX_UNREAD_CONVERSATIONS: '0',
      },
      projectRoot: '/tmp/reporter',
    }),
    /MAX_UNREAD_CONVERSATIONS/,
  );
});

test('loadConfig validates the IANA timezone', () => {
  assert.throws(
    () => loadConfig({
      env: {
        PORTAL_WEBHOOK_URL: validPortalUrl,
        PORTAL_CALL_SECRET: validCallSecret,
        REPORT_TIMEZONE: 'Mars/Olympus',
      },
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

test('redactSecrets removes portal credentials supplied as secrets', () => {
  const message = `Request failed for ${validPortalUrl} with ${validCallSecret}`;
  const redacted = redactSecrets(message, { secrets: [validPortalUrl, validCallSecret] });
  assert.equal(redacted.includes(validPortalUrl), false);
  assert.equal(redacted.includes(validCallSecret), false);
});

test('redactSecrets deduplicates overlapping secrets and redacts longest first', () => {
  const callSecret = 'shared-secret';
  const portalUrl = `https://portal.example.test/hooks/${callSecret}`;
  assert.equal(
    redactSecrets(`${portalUrl} ${callSecret}`, {
      secrets: [callSecret, portalUrl, callSecret],
    }),
    '[REDACTED_PORTAL_SECRET] [REDACTED_PORTAL_SECRET]',
  );
});

test('redactSecrets still removes Slack webhook URLs without explicit secrets', () => {
  const redacted = redactSecrets(`Request failed for ${validSlackWebhook}`);
  assert.equal(redacted, 'Request failed for [REDACTED_SLACK_WEBHOOK]');
  assert.equal(redacted.includes(validSlackWebhook), false);
});

test('loadConfig preserves the legacy Slack webhook contract when requested', () => {
  const config = loadConfig({
    env: { SLACK_WEBHOOK_URL: validSlackWebhook },
    projectRoot: '/tmp/reporter',
    requireWebhook: true,
  });
  assert.equal(config.slackWebhookUrl, validSlackWebhook);
  assert.equal(config.portalWebhookUrl, null);
  assert.equal(config.portalCallSecret, null);
});

test('loadConfig validates Slack only when the legacy contract is requested', () => {
  const env = {
    PORTAL_WEBHOOK_URL: validPortalUrl,
    PORTAL_CALL_SECRET: validCallSecret,
    SLACK_WEBHOOK_URL: 'malformed-legacy-value',
  };
  const config = loadConfig({ env, projectRoot: '/tmp/reporter' });
  assert.equal(config.portalWebhookUrl, validPortalUrl);
  assert.equal(config.slackWebhookUrl, null);
  assert.throws(
    () => loadConfig({ env, projectRoot: '/tmp/reporter', requireWebhook: true }),
    /SLACK_WEBHOOK_URL/,
  );
});

test('loadConfig requires an HTTPS portal URL and call secret for delivery', () => {
  const config = loadConfig({
    env: {
      PORTAL_WEBHOOK_URL: 'https://portal.example.test/hooks/linkedin',
      PORTAL_CALL_SECRET: 'private-call-secret',
    },
    projectRoot: '/tmp/reporter',
    requirePortal: true,
  });
  assert.equal(config.portalWebhookUrl, 'https://portal.example.test/hooks/linkedin');
  assert.equal(config.portalCallSecret, 'private-call-secret');
  assert.equal(config.outboxPath, '/tmp/reporter/.linkedin-unread-outbox.json');
  assert.equal(config.outboxLockPath, '/tmp/reporter/.linkedin-unread-outbox.lock');
});

test('loadConfig rejects HTTP portal URLs without echoing secrets', () => {
  assert.throws(() => loadConfig({
    env: {
      PORTAL_WEBHOOK_URL: 'http://portal.example.test/hooks/linkedin',
      PORTAL_CALL_SECRET: 'do-not-print-this',
    },
    requirePortal: true,
  }), (error) => /HTTPS/.test(error.message) && !/do-not-print-this/.test(error.message));
});
