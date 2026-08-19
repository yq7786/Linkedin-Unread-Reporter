import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { PlaywrightLinkedInAdapter } from '../src/browser.js';
import { runCli } from '../src/cli.js';
import { loadOutbox } from '../src/outbox.js';
import { captureUnreadMessages } from '../src/scanner.js';
import { runPortalWorkflow } from '../src/workflow.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const unreadUrl = 'https://www.linkedin.com/messaging/?filter=unread';
const threadOneUrl = 'https://www.linkedin.com/messaging/thread/thread-1/';
const threadTwoUrl = 'https://www.linkedin.com/messaging/thread/thread-2/';
const portalWebhookUrl = 'https://portal.example.test/hooks/linkedin';
const portalCallSecret = 'private-call-secret';
const scanStartedAt = new Date('2026-08-19T03:00:00.000Z');

const unreadFixture = `<!doctype html>
<html><body>
  <button aria-pressed="true">Unread</button>
  <ul data-reporter-conversation-list>
    <li data-reporter-row-id="human-1" class="msg-conversation-listitem--unread">
      <h3 data-reporter-name>Ada</h3>
      <a href="/messaging/thread/thread-1/?trk=discarded#latest">Open</a>
      <span aria-label="2 unread messages"></span>
      <p data-preview>Private preview one</p>
    </li>
    <li data-reporter-row-id="human-2" class="msg-conversation-listitem--unread">
      <h3 data-reporter-name>Grace</h3>
      <a href="/messaging/thread/thread-2/">Open</a>
      <span aria-label="1 unread message"></span>
      <p data-preview>Private preview two</p>
    </li>
  </ul>
</body></html>`;

const anchorlessUnreadFixture = `<!doctype html>
<html><body>
  <button aria-pressed="true">Unread</button>
  <ul data-reporter-conversation-list>
    <li data-reporter-row-id="human-restart" class="msg-conversation-listitem--unread"
        onclick="history.pushState({}, '', '/messaging/thread/thread-2/'); document.querySelector('.msg-thread').hidden = false">
      <h3 data-reporter-name>Grace</h3>
      <span aria-label="1 unread message"></span>
      <p data-preview>Private restart preview</p>
    </li>
  </ul>
  <section class="msg-thread" hidden>Opened thread</section>
</body></html>`;

const emptyUnreadFixture = `<!doctype html>
<html><body>
  <button aria-pressed="true">Unread</button>
  <ul data-reporter-conversation-list><li>Nothing unread</li></ul>
</body></html>`;

function configuration(directory) {
  return {
    outboxPath: path.join(directory, 'outbox.json'),
    outboxLockPath: path.join(directory, 'outbox.lock'),
    timestampWorkPath: path.join(directory, 'timestamp-work.json'),
    timestampResultPath: path.join(directory, 'timestamp-results.json'),
    unreadUrl,
    maxUnreadConversations: 50,
    authTimeoutMs: 5_000,
    portalWebhookUrl,
    portalCallSecret,
  };
}

async function withTempDirectory(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-workflow-fixture-'));
  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function withFixtureBrowser(callback) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    return await callback(page);
  } finally {
    await browser.close();
  }
}

function timestampNotifier(config, logs) {
  return ({ count, attempt }) => {
    logs.push(`Timestamp normalization required: ${count} item(s), attempt ${attempt} of 3.`);
    const work = JSON.parse(fsSync.readFileSync(config.timestampWorkPath, 'utf8'));
    const temporaryPath = `${config.timestampResultPath}.fixture-tmp`;
    const result = {
      version: 1,
      workId: work.workId,
      items: work.items.map(({ itemKey }) => ({
        itemKey,
        sentAt: '2026-08-19T02:06:00.000Z',
      })),
    };
    fsSync.writeFileSync(temporaryPath, `${JSON.stringify(result)}\n`, { mode: 0o600 });
    fsSync.renameSync(temporaryPath, config.timestampResultPath);
  };
}

function assertNoPrivateOutput(output) {
  const text = output.join('\n');
  for (const privateValue of [
    'Ada',
    'Grace',
    'Hello',
    'LinkedIn 👋',
    'Only visible message',
    unreadUrl,
    threadOneUrl,
    threadTwoUrl,
    portalWebhookUrl,
    portalCallSecret,
  ]) {
    assert.equal(text.includes(privateValue), false);
  }
  assert.doesNotMatch(text, /https:\/\//);
}

async function captureProcessOutput(output, operation, {
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const originalStdoutWrite = stdout.write;
  const originalStderrWrite = stderr.write;
  const intercept = () => function interceptedWrite(chunk, encoding, callback) {
    output.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    const completion = typeof encoding === 'function' ? encoding : callback;
    if (typeof completion === 'function') queueMicrotask(completion);
    return true;
  };
  stdout.write = intercept();
  stderr.write = intercept();
  try {
    return await operation();
  } finally {
    stdout.write = originalStdoutWrite;
    stderr.write = originalStderrWrite;
  }
}

async function runScheduledWorkflow({
  config,
  adapter,
  fetchImpl,
  logs,
  stdout,
  stderr,
}) {
  let workflowResult;
  const exitCode = await runCli(['scheduled-report'], {
    projectRoot: path.dirname(config.outboxPath),
    readEnvImpl: () => ({}),
    loadConfigImpl: () => config,
    captureImpl: (_config, options) => captureUnreadMessages({ ...options, adapter }),
    workflowImpl: async (options) => {
      workflowResult = await runPortalWorkflow({
        ...options,
        fetchImpl,
        notifyTimestampWork: (payload) => {
          timestampNotifier(config, logs)(payload);
          options.notifyTimestampWork(payload);
        },
        now: () => new Date(scanStartedAt),
      });
      return workflowResult;
    },
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return { exitCode, result: workflowResult };
}

test('full workflow captures, checkpoints, normalizes, deduplicates, and clears outbox', async () => {
  await withTempDirectory(async (directory) => withFixtureBrowser(async (page) => {
    const config = configuration(directory);
    const logs = [];
    const stdout = [];
    const stderr = [];
    const portalBatches = [];
    const threadOne = await fs.readFile(path.join(fixtures, 'unread-thread.html'), 'utf8');
    const threadTwo = await fs.readFile(path.join(fixtures, 'unread-thread-no-boundary.html'), 'utf8');
    await page.route('https://www.linkedin.com/messaging/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const body = pathname === '/messaging/thread/thread-1/'
        ? threadOne
        : pathname === '/messaging/thread/thread-2/' ? threadTwo : unreadFixture;
      await route.fulfill({ contentType: 'text/html', body });
    });
    const adapter = new PlaywrightLinkedInAdapter(page, {
      authTimeoutMs: config.authTimeoutMs,
      recoveryOptions: { pollIntervalMs: 10 },
    });
    const fetchImpl = async (_url, request) => {
      const batch = JSON.parse(request.body);
      portalBatches.push(batch);
      return {
        status: 200,
        json: async () => ({
          results: batch.messages.map(({ idempotencyKey }, index) => ({
            idempotencyKey,
            status: index === 1 ? 'duplicate' : 'created',
          })),
        }),
      };
    };

    const execution = await runScheduledWorkflow({
      config,
      adapter,
      fetchImpl,
      logs,
      stdout,
      stderr,
    });
    const { result } = execution;

    assert.equal(execution.exitCode, 0);
    assert.deepEqual(stderr, []);
    assert.deepEqual(result, {
      processedConversations: 2,
      capturedMessages: 3,
      created: 2,
      duplicate: 1,
      assumedDuplicate: 0,
      pendingRecovery: 0,
      pendingTimestamps: 0,
    });
    assert.equal(portalBatches.length, 1);
    assert.equal(portalBatches[0].messages.length, 3);
    assert.deepEqual((await loadOutbox({ outboxPath: config.outboxPath })).entries, []);
    assert.equal((await fs.stat(config.outboxPath)).mode & 0o777, 0o600);
    assert.deepEqual(await fs.readdir(directory), ['outbox.json']);
    assert.deepEqual(stdout, [
      'Timestamp normalization required: 1 item(s), attempt 1 of 3.',
      'Processed: 2 conversations; Captured: 3 messages; Created: 2; Duplicates: 1; '
        + 'Assumed duplicates: 0; Pending recovery: 0; Pending timestamps: 0',
    ]);
    assertNoPrivateOutput([...logs, ...stdout, ...stderr]);
  }));
});

test('runtime output capture records private text without forwarding it', async () => {
  const captured = [];
  const forwarded = [];
  const completions = [];
  const streams = {
    stdout: { write: (chunk) => { forwarded.push(String(chunk)); return false; } },
    stderr: { write: (chunk) => { forwarded.push(String(chunk)); return false; } },
  };

  await captureProcessOutput(captured, async () => {
    let synchronous = true;
    assert.equal(streams.stdout.write('Private sentinel output', 'utf8', () => {
      completions.push(synchronous ? 'sync-stdout' : 'async-stdout');
    }), true);
    assert.equal(streams.stderr.write(Buffer.from('Private sentinel error'), () => {
      completions.push(synchronous ? 'sync-stderr' : 'async-stderr');
    }), true);
    assert.deepEqual(completions, []);
    synchronous = false;
    await Promise.resolve();
  }, streams);

  assert.deepEqual(captured, ['Private sentinel output', 'Private sentinel error']);
  assert.deepEqual(completions.sort(), ['async-stderr', 'async-stdout']);
  assert.deepEqual(forwarded, []);
  assert.equal(streams.stdout.write('Restored public output'), false);
  assert.deepEqual(forwarded, ['Restored public output']);
});

test('restart recovers a post-open extraction failure by direct URL and delivers once', async () => {
  await withTempDirectory(async (directory) => withFixtureBrowser(async (page) => {
    const config = configuration(directory);
    const logs = [];
    const stdout = [];
    const stderr = [];
    const directOpenUrls = [];
    const portalBatches = [];
    const thread = await fs.readFile(path.join(fixtures, 'unread-thread-no-boundary.html'), 'utf8');
    let restarted = false;
    await page.route('https://www.linkedin.com/messaging/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const body = pathname === '/messaging/thread/thread-2/'
        ? thread
        : restarted ? emptyUnreadFixture : anchorlessUnreadFixture;
      await route.fulfill({ contentType: 'text/html', body });
    });
    const realAdapter = new PlaywrightLinkedInAdapter(page, {
      authTimeoutMs: config.authTimeoutMs,
      recoveryOptions: { pollIntervalMs: 10 },
    });
    let failExtraction = true;
    const adapter = {
      gotoUnread: (...args) => realAdapter.gotoUnread(...args),
      waitForUnblocked: (...args) => realAdapter.waitForUnblocked(...args),
      readUnreadCandidates: (...args) => realAdapter.readUnreadCandidates(...args),
      openConversation: async (candidate, options) => {
        if (candidate.conversationUrl) directOpenUrls.push(candidate.conversationUrl);
        return realAdapter.openConversation(candidate, options);
      },
      readThreadMessages: async () => {
        if (failExtraction) throw new Error('Thread extraction failed.');
        return realAdapter.readThreadMessages();
      },
    };
    const fetchImpl = async (_url, request) => {
      const batch = JSON.parse(request.body);
      portalBatches.push(batch);
      return {
        status: 200,
        json: async () => ({
          results: batch.messages.map(({ idempotencyKey }) => ({
            idempotencyKey,
            status: 'created',
          })),
        }),
      };
    };
    const workflowOptions = {
      config,
      adapter,
      fetchImpl,
      logs,
      stdout,
      stderr,
    };

    const failed = await runScheduledWorkflow(workflowOptions);
    assert.equal(failed.exitCode, 1);
    assert.equal(failed.result, undefined);
    assert.deepEqual(stderr, ['Unexpected failure.']);
    const checkpoint = await loadOutbox({ outboxPath: config.outboxPath });
    assert.equal(checkpoint.entries.length, 1);
    assert.equal(checkpoint.entries[0].state, 'capture_pending');
    assert.equal(checkpoint.entries[0].conversationUrl, threadTwoUrl);
    assert.equal((await fs.stat(config.outboxPath)).mode & 0o777, 0o600);
    assert.deepEqual(await fs.readdir(directory), ['outbox.json']);
    assert.equal(portalBatches.length, 0);

    restarted = true;
    failExtraction = false;
    const recoveredExecution = await runScheduledWorkflow(workflowOptions);
    const recovered = recoveredExecution.result;
    assert.equal(recoveredExecution.exitCode, 0);
    assert.deepEqual(recovered, {
      processedConversations: 1,
      capturedMessages: 1,
      created: 1,
      duplicate: 0,
      assumedDuplicate: 0,
      pendingRecovery: 0,
      pendingTimestamps: 0,
    });
    assert.deepEqual(directOpenUrls, [threadTwoUrl]);
    assert.equal(portalBatches.length, 1);
    assert.equal(portalBatches[0].messages.length, 1);
    assert.deepEqual((await loadOutbox({ outboxPath: config.outboxPath })).entries, []);

    const noReplayExecution = await runScheduledWorkflow(workflowOptions);
    const noReplay = noReplayExecution.result;
    assert.equal(noReplayExecution.exitCode, 0);
    assert.deepEqual(noReplay, {
      processedConversations: 0,
      capturedMessages: 0,
      created: 0,
      duplicate: 0,
      assumedDuplicate: 0,
      pendingRecovery: 0,
      pendingTimestamps: 0,
    });
    assert.equal(portalBatches.length, 1);
    assert.equal((await fs.stat(config.outboxPath)).mode & 0o777, 0o600);
    assert.deepEqual(await fs.readdir(directory), ['outbox.json']);
    assertNoPrivateOutput([...logs, ...stdout, ...stderr]);
  }));
});
