import assert from 'node:assert/strict';
import test from 'node:test';

import * as cli from '../src/cli.js';
import { LinkedInBlockerError } from '../src/browser.js';
import { ConfigError } from '../src/config.js';
import { ScanInvariantError } from '../src/linkedin-state.js';
import { MessageDataError } from '../src/messages.js';
import { OutboxValidationError } from '../src/outbox.js';
import { PortalDeliveryError } from '../src/portal.js';

const { performBrowserLogin, runCaptureDryRun, runCli } = cli;
const requiredExport = (name) => {
  assert.equal(typeof cli[name], 'function', `${name} must be exported`);
  return cli[name];
};

const config = {
  projectRoot: '/tmp/reporter',
  portalWebhookUrl: 'https://portal.example.test/hooks/linkedin',
  portalCallSecret: 'private-call-secret',
  browserProfilePath: '/tmp/reporter/.linkedin-browser-profile',
  outboxPath: '/tmp/reporter/.linkedin-unread-outbox.json',
  outboxLockPath: '/tmp/reporter/.linkedin-unread-outbox.lock',
  timestampWorkPath: '/tmp/reporter/.linkedin-timestamp-work.json',
  timestampResultPath: '/tmp/reporter/.linkedin-timestamp-results.json',
  unreadUrl: 'https://www.linkedin.com/messaging/?filter=unread',
  maxUnreadConversations: 50,
  authTimeoutMs: 900_000,
};

const emptyCounts = () => ({
  processedConversations: 0, capturedMessages: 0, created: 0, duplicate: 0,
  assumedDuplicate: 0, pendingRecovery: 0, pendingTimestamps: 0,
});

function harness(overrides = {}) {
  const stdout = [];
  const stderr = [];
  const calls = { configure: 0, login: 0, capture: 0, workflow: [] };
  const dependencies = {
    projectRoot: '/tmp/reporter',
    isInteractive: true,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    loadConfigImpl: () => config,
    readEnvImpl: () => ({}),
    configurePortalImpl: async () => { calls.configure += 1; },
    loginImpl: async () => { calls.login += 1; },
    captureDryRunImpl: async () => {
      calls.capture += 1;
      return {
        processedConversations: 2, capturedMessages: 3, pendingRecovery: 0, pendingTimestamps: 0,
      };
    },
    workflowImpl: async (options) => {
      calls.workflow.push(options);
      return emptyCounts();
    },
    ...overrides,
  };
  return { dependencies, stdout, stderr, calls };
}

test('configure requires an interactive terminal', async () => {
  const { dependencies, stderr, calls } = harness({ isInteractive: false });
  assert.equal(await runCli(['configure'], dependencies), 1);
  assert.equal(calls.configure, 0);
  assert.match(stderr.join('\n'), /interactive terminal/);
});

test('configure stores portal configuration without printing either secret', async () => {
  const { dependencies, stdout, calls } = harness();
  assert.equal(await runCli(['configure'], dependencies), 0);
  assert.equal(calls.configure, 1);
  assert.match(stdout.join('\n'), /Portal configuration saved securely/);
  assert.doesNotMatch(stdout.join('\n'), /portal\.example|private-call-secret/);
});

test('login preserves the persistent browser flow without requiring portal configuration', async () => {
  let requirePortal;
  const { dependencies, stdout, calls } = harness({
    loadConfigImpl: (options) => {
      requirePortal = options.requirePortal;
      return { ...config, portalWebhookUrl: null, portalCallSecret: null };
    },
  });
  assert.equal(await runCli(['login'], dependencies), 0);
  assert.equal(requirePortal, false);
  assert.equal(calls.login, 1);
  assert.equal(calls.capture, 0);
  assert.equal(calls.workflow.length, 0);
  assert.match(stdout.join('\n'), /session saved.*closed/i);
});

test('scan captures to the outbox without portal delivery', async () => {
  let requirePortal;
  const { dependencies, stdout, calls } = harness({
    loadConfigImpl: (options) => {
      requirePortal = options.requirePortal;
      return { ...config, portalWebhookUrl: null, portalCallSecret: null };
    },
  });
  assert.equal(await runCli(['scan'], dependencies), 0);
  assert.equal(requirePortal, false);
  assert.equal(calls.capture, 1);
  assert.equal(calls.workflow.length, 0);
  assert.match(stdout.join('\n'), /Captured: 3 messages from 2 conversations/);
  assert.doesNotMatch(stdout.join('\n'), /Ada|Hello|messaging\/thread/);
});

test('deliver runs the workflow without new LinkedIn capture', async () => {
  const { dependencies, stdout, calls } = harness({
    workflowImpl: async (options) => {
      calls.workflow.push(options);
      return { ...emptyCounts(), created: 2, duplicate: 1 };
    },
  });
  assert.equal(await runCli(['deliver'], dependencies), 0);
  assert.equal(calls.capture, 0);
  assert.equal(calls.workflow.length, 1);
  assert.equal(calls.workflow[0].captureNew, false);
  assert.match(stdout.join('\n'), /Created: 2.*Duplicates: 1/);
});

test('scheduled-report runs the complete workflow and prints counts only', async () => {
  const privateValues = ['leadName', 'content', 'conversationUrl', 'Ada', 'Hello'];
  const { dependencies, stdout, calls } = harness({
    workflowImpl: async (options) => {
      calls.workflow.push(options);
      return {
        ...emptyCounts(), processedConversations: 2, capturedMessages: 3, created: 2, duplicate: 1,
      };
    },
  });
  assert.equal(await runCli(['scheduled-report'], dependencies), 0);
  assert.equal(calls.workflow.length, 1);
  assert.equal(calls.workflow[0].captureNew, true);
  assert.match(stdout.join('\n'), /Created: 2.*Duplicates: 1/);
  for (const value of privateValues) assert.doesNotMatch(stdout.join('\n'), new RegExp(value));
});

test('timestamp work notifications expose counts and attempts only', async () => {
  const { dependencies, stdout } = harness({
    workflowImpl: async ({ notifyTimestampWork }) => {
      notifyTimestampWork({ count: 4, attempt: 2 });
      return emptyCounts();
    },
  });
  assert.equal(await runCli(['scheduled-report'], dependencies), 0);
  assert.match(stdout.join('\n'), /Timestamp normalization required: 4 item\(s\), attempt 2 of 3\./);
});

test('slack-test returns usage without reading configuration or causing side effects', async () => {
  let reads = 0;
  const { dependencies, stderr, calls } = harness({
    readEnvImpl: () => { reads += 1; return {}; },
  });
  assert.equal(await runCli(['slack-test'], dependencies), 1);
  assert.match(stderr.join('\n'), /<configure\|login\|scan\|deliver\|scheduled-report>/);
  assert.equal(reads, 0);
  assert.deepEqual(calls, { configure: 0, login: 0, capture: 0, workflow: [] });
});

test('unexpected errors never expose arbitrary multi-word, JSON-shaped, or unlabeled content', async () => {
  const privateFragments = [
    'Ada Private Person',
    '{"leadName":"Ada","content":"Hello from private thread"}',
    'raw private message body without a label',
    config.portalWebhookUrl,
    config.portalCallSecret,
    'https://www.linkedin.com/messaging/thread/private-thread/',
  ];
  for (const privateFragment of privateFragments) {
    const { dependencies, stderr } = harness({
      captureDryRunImpl: async () => { throw new Error(privateFragment); },
    });
    assert.equal(await runCli(['scan'], dependencies), 1);
    assert.equal(stderr.join('\n'), 'Unexpected failure.');
    assert.equal(stderr.join('\n').includes(privateFragment), false);
  }
});

test('known sanitized internal errors remain actionable', async () => {
  const knownErrors = [
    new ConfigError('Portal delivery is not configured. Run `npm run configure` in an interactive terminal.'),
    new LinkedInBlockerError('captcha'),
    new ScanInvariantError('conversation-list-missing'),
    new MessageDataError('message-id-invalid'),
    new OutboxValidationError(),
    new PortalDeliveryError('Portal delivery failed (network).'),
    new Error('Timestamp result polling timed out.'),
    new Error('Workflow dependency output is invalid.'),
  ];
  for (const knownError of knownErrors) {
    const { dependencies, stderr } = harness({
      captureDryRunImpl: async () => { throw knownError; },
    });
    assert.equal(await runCli(['scan'], dependencies), 1);
    assert.equal(stderr.join('\n'), knownError.message);
  }
});

test('known error classes reconstruct messages without trusting mutable message text', async () => {
  const cases = [
    [new ScanInvariantError('conversation-list-missing'),
      'LinkedIn unread-list safety invariant failed: conversation-list-missing. No report was sent.'],
    [new MessageDataError('message-id-invalid'), 'message-id-invalid'],
    [new LinkedInBlockerError('captcha'),
      'LinkedIn captcha was not cleared within the allowed time. No report was sent.'],
    [new OutboxValidationError(), 'Outbox data is invalid.'],
  ];
  for (const [error, expected] of cases) {
    error.message = 'Ada Private Person {"content":"private JSON"} raw secret';
    const { dependencies, stderr } = harness({
      captureDryRunImpl: async () => { throw error; },
    });
    assert.equal(await runCli(['scan'], dependencies), 1);
    assert.equal(stderr.join('\n'), expected);
  }
});

test('new scan safety codes reconstruct static messages and ignore mutated message text', async () => {
  for (const code of [
    'conversation-row-no-longer-eligible',
    'conversation-row-url-changed',
    'candidate-revalidation-failed',
    'conversation-list-progress-invalid',
  ]) {
    const error = new ScanInvariantError(code);
    error.message = 'Private Person {"content":"private thread"}';
    const { dependencies, stderr } = harness({
      captureDryRunImpl: async () => { throw error; },
    });

    assert.equal(await runCli(['scan'], dependencies), 1);
    assert.equal(
      stderr.join('\n'),
      `LinkedIn unread-list safety invariant failed: ${code}. No report was sent.`,
    );
  }
});

test('subclassed known errors are not trusted even with allowlisted metadata', async () => {
  class AdversarialConfigError extends ConfigError {}
  class AdversarialScanError extends ScanInvariantError {}
  class AdversarialPortalError extends PortalDeliveryError {}
  const errors = [
    new AdversarialConfigError('Portal delivery is not configured. Run `npm run configure` in an interactive terminal.'),
    new AdversarialScanError('conversation-list-missing'),
    new AdversarialPortalError('Portal delivery failed (network).'),
  ];
  for (const error of errors) {
    const { dependencies, stderr } = harness({
      captureDryRunImpl: async () => { throw error; },
    });
    assert.equal(await runCli(['scan'], dependencies), 1);
    assert.equal(stderr.join('\n'), 'Unexpected failure.');
  }
});

test('mutated config and portal errors cannot smuggle private text', async () => {
  const errors = [
    new ConfigError('Portal delivery is not configured. Run `npm run configure` in an interactive terminal.'),
    new PortalDeliveryError('Portal delivery failed (network).'),
  ];
  for (const error of errors) {
    error.message = 'raw private content {"leadName":"Ada"}';
    const { dependencies, stderr } = harness({
      captureDryRunImpl: async () => { throw error; },
    });
    assert.equal(await runCli(['scan'], dependencies), 1);
    assert.equal(stderr.join('\n'), 'Unexpected failure.');
  }
});

test('count projection rejects undefined, missing, and string capture counts', async () => {
  const invalidResults = [
    undefined,
    { processedConversations: 2, capturedMessages: 3, pendingRecovery: 0 },
    { processedConversations: 2, capturedMessages: '3', pendingRecovery: 0, pendingTimestamps: 0 },
  ];
  for (const invalidResult of invalidResults) {
    const { dependencies, stderr } = harness({ captureDryRunImpl: async () => invalidResult });
    assert.equal(await runCli(['scan'], dependencies), 1);
    assert.equal(stderr.join('\n'), 'Unexpected failure.');
  }
});

test('scan projects private extra fields away from count-only output', async () => {
  const { dependencies, stdout } = harness({
    captureDryRunImpl: async () => ({
      processedConversations: 2,
      capturedMessages: 3,
      pendingRecovery: 0,
      pendingTimestamps: 0,
      content: 'private extra content',
    }),
  });
  assert.equal(await runCli(['scan'], dependencies), 0);
  assert.doesNotMatch(stdout.join('\n'), /private extra content|content/);
});

test('workflow count projection requires every full count and removes extras', async () => {
  const { dependencies: invalidDependencies, stderr } = harness({
    workflowImpl: async () => ({ ...emptyCounts(), pendingTimestamps: undefined }),
  });
  assert.equal(await runCli(['scheduled-report'], invalidDependencies), 1);
  assert.equal(stderr.join('\n'), 'Unexpected failure.');

  const { dependencies, stdout } = harness({
    workflowImpl: async () => ({ ...emptyCounts(), content: 'private workflow extra' }),
  });
  assert.equal(await runCli(['scheduled-report'], dependencies), 0);
  assert.doesNotMatch(stdout.join('\n'), /private workflow extra|content/);
});

test('blocker callback accepts only an exact plain object and allowlisted blocker type', async () => {
  const { dependencies, stderr } = harness({
    loginImpl: async (_config, { onBlocker }) => {
      onBlocker({ type: 'captcha' });
    },
  });
  assert.equal(await runCli(['login'], dependencies), 0);
  assert.equal(
    stderr.join('\n'),
    'LinkedIn requires manual captcha. Complete it in the visible browser within 15 minutes.',
  );

  const privatePayloads = [
    { type: 'captcha', content: 'Ada Private Person' },
    { type: 'raw private message body' },
    { type: '{"content":"private JSON"}' },
    Object.assign(Object.create({ inherited: true }), { type: 'login' }),
  ];
  for (const payload of privatePayloads) {
    const current = harness({
      loginImpl: async (_config, { onBlocker }) => onBlocker(payload),
    });
    assert.equal(await runCli(['login'], current.dependencies), 1);
    assert.equal(current.stderr.join('\n'), 'Unexpected failure.');
  }
});

test('timestamp notification accepts only exact validated count and attempt fields', async () => {
  const invalidPayloads = [
    undefined,
    { count: 1 },
    { count: '1', attempt: 1 },
    { count: 1, attempt: 0 },
    { count: 1, attempt: 4 },
    { count: 1, attempt: 1, content: 'Ada Private Person' },
    { count: 1, attempt: '{"content":"private JSON"}' },
  ];
  for (const payload of invalidPayloads) {
    const { dependencies, stdout, stderr } = harness({
      workflowImpl: async ({ notifyTimestampWork }) => {
        notifyTimestampWork(payload);
        return emptyCounts();
      },
    });
    assert.equal(await runCli(['scheduled-report'], dependencies), 1);
    assert.equal(stdout.join('\n'), '');
    assert.equal(stderr.join('\n'), 'Unexpected failure.');
  }
});

test('performBrowserLogin navigates and waits without reading conversation rows', async () => {
  const calls = [];
  const adapter = {
    gotoUnread: async (url) => calls.push(['gotoUnread', url]),
    waitForUnblocked: async (timeoutMs) => calls.push(['waitForUnblocked', timeoutMs]),
    readRows: async () => { throw new Error('login must not read rows'); },
  };
  await performBrowserLogin(config, {
    chromiumImpl: { marker: 'chromium' },
    withBrowserImpl: async (options) => {
      assert.equal(options.profilePath, config.browserProfilePath);
      assert.equal(options.chromium.marker, 'chromium');
      return options.task(adapter);
    },
  });
  assert.deepEqual(calls, [
    ['gotoUnread', config.unreadUrl],
    ['waitForUnblocked', config.authTimeoutMs],
  ]);
});

test('performBrowserCapture supplies a real adapter to message capture', async () => {
  const adapter = { marker: 'adapter' };
  const captureOptions = { outbox: { version: 1, entries: [] }, captureNew: true };
  const result = await requiredExport('performBrowserCapture')(config, captureOptions, {
    chromiumImpl: { marker: 'chromium' },
    withBrowserImpl: async (options) => {
      assert.equal(options.profilePath, config.browserProfilePath);
      assert.equal(options.chromium.marker, 'chromium');
      return options.task(adapter);
    },
    captureImpl: async (options) => {
      assert.equal(options.adapter, adapter);
      assert.equal(options.outbox, captureOptions.outbox);
      assert.equal(options.captureNew, true);
      return { marker: 'captured' };
    },
  });
  assert.deepEqual(result, { marker: 'captured' });
});

test('capture dry run locks, loads, and checkpoints under workflow configuration', async () => {
  const events = [];
  const outbox = { version: 1, entries: [] };
  const result = await requiredExport('runCaptureDryRun')({
    config,
    withLock: async ({ lockPath, task }) => {
      events.push(['lock', lockPath]);
      return task({ signal: new AbortController().signal });
    },
    load: async ({ outboxPath }) => {
      events.push(['load', outboxPath]);
      return outbox;
    },
    save: async ({ outboxPath, value }) => events.push(['save', outboxPath, value]),
    capture: async (options) => {
      assert.equal(options.outbox, outbox);
      assert.equal(options.unreadUrl, config.unreadUrl);
      assert.equal(options.cap, config.maxUnreadConversations);
      assert.equal(options.authTimeoutMs, config.authTimeoutMs);
      assert.equal(options.recoverPending, true);
      assert.equal(options.captureNew, true);
      await options.saveOutbox(outbox);
      return {
        outbox, processedConversations: 2, capturedMessages: 3,
        pendingRecovery: 0, pendingTimestamps: 1,
      };
    },
    now: () => new Date('2026-08-19T03:00:00.000Z'),
  });
  assert.deepEqual(events, [
    ['lock', config.outboxLockPath],
    ['load', config.outboxPath],
    ['save', config.outboxPath, outbox],
  ]);
  assert.deepEqual(result, {
    processedConversations: 2, capturedMessages: 3, pendingRecovery: 0, pendingTimestamps: 1,
  });
});

test('capture dry run stops after an abort during load before browser capture', async () => {
  const controller = new AbortController();
  const compromise = new Error('lock compromised');
  let captures = 0;
  await assert.rejects(runCaptureDryRun({
    config,
    withLock: async ({ task }) => task({ signal: controller.signal }),
    load: async () => {
      controller.abort(compromise);
      return { version: 1, entries: [] };
    },
    capture: async () => { captures += 1; },
  }), (error) => error === compromise);
  assert.equal(captures, 0);
});

test('capture dry run gives an abort during save precedence over the save error', async () => {
  const controller = new AbortController();
  const compromise = new Error('lock compromised');
  const saveError = new Error('unexpected private save details');
  await assert.rejects(runCaptureDryRun({
    config,
    withLock: async ({ task }) => task({ signal: controller.signal }),
    load: async () => ({ version: 1, entries: [] }),
    save: async () => {
      controller.abort(compromise);
      throw saveError;
    },
    capture: async ({ outbox, saveOutbox }) => {
      await saveOutbox(outbox);
    },
  }), (error) => error === compromise);
});

test('capture dry run preserves an unexpected save error while the lock remains healthy', async () => {
  const saveError = new Error('unexpected save failure');
  await assert.rejects(runCaptureDryRun({
    config,
    withLock: async ({ task }) => task({ signal: new AbortController().signal }),
    load: async () => ({ version: 1, entries: [] }),
    save: async () => { throw saveError; },
    capture: async ({ outbox, saveOutbox }) => saveOutbox(outbox),
  }), (error) => error === saveError);
});
