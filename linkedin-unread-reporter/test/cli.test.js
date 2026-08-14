import assert from 'node:assert/strict';
import test from 'node:test';

import { runCli } from '../src/cli.js';
import { ConfigError } from '../src/config.js';

const config = {
  projectRoot: '/tmp/reporter',
  slackWebhookUrl: ['https://hooks.slack.com', 'services', 'AAA', 'BBB', 'CCC'].join('/'),
  browserProfilePath: '/tmp/reporter/.linkedin-browser-profile',
  unreadUrl: 'https://www.linkedin.com/messaging/?filter=unread',
  maxUnreadConversations: 50,
  authTimeoutMs: 900_000,
  reportTimezone: 'Australia/Adelaide',
};

function harness(overrides = {}) {
  const stdout = [];
  const stderr = [];
  const slackCalls = [];
  const dependencies = {
    projectRoot: '/tmp/reporter',
    isInteractive: true,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    loadConfigImpl: () => config,
    readEnvImpl: () => ({}),
    configureSlackImpl: async () => ({ configured: true }),
    scanImpl: async () => ({ conversations: [], truncated: false }),
    postSlackImpl: async (input) => { slackCalls.push(input); return { delivered: true }; },
    now: () => new Date('2026-08-14T02:30:00.000Z'),
    ...overrides,
  };
  return { dependencies, stdout, stderr, slackCalls };
}

test('configure requires an interactive terminal', async () => {
  const { dependencies, stderr } = harness({ isInteractive: false });
  assert.equal(await runCli(['configure'], dependencies), 1);
  assert.match(stderr.join('\n'), /interactive terminal/);
});

test('configure confirms success without returning the webhook', async () => {
  const { dependencies, stdout } = harness();
  assert.equal(await runCli(['configure'], dependencies), 0);
  assert.match(stdout.join('\n'), /saved securely/);
  assert.doesNotMatch(stdout.join('\n'), /hooks\.slack\.com/);
});

test('scan reports only a count and never names', async () => {
  const { dependencies, stdout } = harness({
    scanImpl: async () => ({ conversations: [{ id: '1', name: 'Private Person' }], truncated: false }),
  });
  assert.equal(await runCli(['scan'], dependencies), 0);
  assert.match(stdout.join('\n'), /1 conversation/);
  assert.doesNotMatch(stdout.join('\n'), /Private Person/);
});

test('slack-test sends one clearly labeled message', async () => {
  const { dependencies, slackCalls } = harness();
  assert.equal(await runCli(['slack-test'], dependencies), 0);
  assert.equal(slackCalls.length, 1);
  assert.match(slackCalls[0].text, /test/i);
});

test('interactive publishing configures a missing webhook locally and resumes', async () => {
  let loadAttempts = 0;
  let configureCalls = 0;
  const { dependencies, slackCalls } = harness({
    loadConfigImpl: () => {
      loadAttempts += 1;
      if (loadAttempts === 1) throw new ConfigError('SLACK_WEBHOOK_URL is not configured.');
      return config;
    },
    configureSlackImpl: async () => { configureCalls += 1; },
  });
  assert.equal(await runCli(['slack-test'], dependencies), 0);
  assert.equal(configureCalls, 1);
  assert.equal(loadAttempts, 2);
  assert.equal(slackCalls.length, 1);
});

test('non-interactive publishing fails instead of waiting for a missing webhook', async () => {
  let configureCalls = 0;
  const { dependencies, stderr } = harness({
    isInteractive: false,
    loadConfigImpl: () => { throw new ConfigError('SLACK_WEBHOOK_URL is not configured.'); },
    configureSlackImpl: async () => { configureCalls += 1; },
  });
  assert.equal(await runCli(['scheduled-report'], dependencies), 1);
  assert.equal(configureCalls, 0);
  assert.match(stderr.join('\n'), /not configured/);
});

test('scheduled-report scans, formats, and posts the report', async () => {
  const { dependencies, stdout, slackCalls } = harness({
    scanImpl: async () => ({ conversations: [{ id: '1', name: 'Ada' }], truncated: false }),
  });
  assert.equal(await runCli(['scheduled-report'], dependencies), 0);
  assert.match(slackCalls[0].text, /^LinkedIn unread message: 1/);
  assert.match(stdout.join('\n'), /delivered.*1 conversation/i);
  assert.doesNotMatch(stdout.join('\n'), /Ada/);
});

test('errors are sanitized and produce a non-zero exit code', async () => {
  const secret = config.slackWebhookUrl;
  const { dependencies, stderr } = harness({
    scanImpl: async () => { throw new Error(`failed at ${secret}`); },
  });
  assert.equal(await runCli(['scan'], dependencies), 1);
  assert.match(stderr.join('\n'), /REDACTED/);
  assert.doesNotMatch(stderr.join('\n'), new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('unknown commands return usage without side effects', async () => {
  const { dependencies, stderr, slackCalls } = harness();
  assert.equal(await runCli(['unknown'], dependencies), 1);
  assert.match(stderr.join('\n'), /Usage:/);
  assert.equal(slackCalls.length, 0);
});
