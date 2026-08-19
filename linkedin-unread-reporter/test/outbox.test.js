import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createEmptyOutbox,
  loadOutbox,
  saveOutbox,
  validateOutbox,
  withOutboxLock,
} from '../src/outbox.js';

async function withTempDirectory(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'linkedin-outbox-'));
  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function exists(target) {
  return fs.access(target).then(() => true, () => false);
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition-not-reached');
}

const common = {
  entryId: 'entry-private-1',
  leadName: 'Private Lead',
  conversationUrl: 'https://www.linkedin.com/messaging/thread/private-thread/',
};

const capturePending = {
  ...common,
  entryId: 'entry-private-capture',
  state: 'capture_pending',
  expectedUnreadCount: 2,
  firstFailureAt: '2026-08-19T03:00:00.000Z',
  attemptCount: 3,
  recoveryMode: 'direct',
};

const preopenPending = {
  ...common,
  entryId: 'entry-private-preopen',
  state: 'preopen_pending',
  expectedUnreadCount: 2,
  firstFailureAt: '2026-08-19T03:00:00.000Z',
  attemptCount: 3,
};

const timestampPending = {
  ...common,
  entryId: 'entry-private-timestamp',
  state: 'timestamp_pending',
  linkedinMessageId: null,
  contentType: 'text',
  content: 'Private content',
  sentAtRaw: '2h',
  scanStartedAt: '2026-08-19T03:00:00.000Z',
};

const ready = {
  ...common,
  entryId: 'entry-private-ready',
  state: 'ready',
  idempotencyKey: 'linkedin:message-1',
  linkedinMessageId: 'message-1',
  contentType: 'text',
  content: 'Private content',
  sentAt: '2026-08-19T01:00:00.000Z',
  sentAtRaw: '2h',
  sentAtAccuracy: 'estimated',
};

function privateStat({ dev = 1, ino = 2, mode = 0o100600, isFile = true } = {}) {
  return { dev, ino, mode, isFile: () => isFile };
}

function readablePrivateFileSystem(text, { openedStat, pathStat, calls = [] } = {}) {
  const handle = {
    stat: async () => { calls.push(['handle.stat']); return openedStat ?? privateStat(); },
    readFile: async (...args) => { calls.push(['handle.readFile', ...args]); return text; },
    close: async () => { calls.push(['handle.close']); },
  };
  return {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000 },
    open: async (...args) => { calls.push(['open', ...args]); return handle; },
    lstat: async (...args) => { calls.push(['lstat', ...args]); return pathStat ?? privateStat(); },
  };
}

test('createEmptyOutbox returns a fresh versioned outbox', () => {
  const first = createEmptyOutbox();
  const second = createEmptyOutbox();
  assert.deepEqual(first, { version: 1, entries: [] });
  assert.notEqual(first, second);
  assert.notEqual(first.entries, second.entries);
});

test('validateOutbox accepts every complete entry state without copying private data', () => {
  const value = {
    version: 1,
    entries: [preopenPending, capturePending, timestampPending, ready],
  };
  assert.equal(validateOutbox(value), value);
});

test('validateOutbox rejects unsupported versions, states, fields, and missing state fields safely', () => {
  const privateValues = ['Private Lead', 'Private content', 'private-thread', 'entry-private'];
  const invalidValues = [
    { version: 2, entries: [] },
    { version: 1, entries: [], extra: true },
    { version: 1, entries: [{ ...ready, state: 'sent' }] },
    { version: 1, entries: [{ ...ready, extra: 'unknown' }] },
    { version: 1, entries: [{ ...capturePending, firstFailureAt: undefined }] },
    { version: 1, entries: [{ ...capturePending, recoveryMode: undefined }] },
    { version: 1, entries: [{ ...capturePending, recoveryMode: 'unread-required' }] },
    { version: 1, entries: [{ ...capturePending, recoveryMode: 'unsafe-direct' }] },
    { version: 1, entries: [{ ...preopenPending, firstFailureAt: undefined }] },
    { version: 1, entries: [{ ...preopenPending, extra: 'unknown' }] },
    { version: 1, entries: [{ ...timestampPending, scanStartedAt: undefined }] },
    { version: 1, entries: [{ ...ready, idempotencyKey: undefined }] },
    { version: 1, entries: [ready, { ...capturePending, entryId: ready.entryId }] },
    { version: 1, entries: [{ ...ready, conversationUrl: 'http://www.linkedin.com/messaging/thread/private-thread/' }] },
    { version: 1, entries: [{ ...ready, conversationUrl: 'https://linkedin.com/messaging/thread/private-thread/' }] },
    { version: 1, entries: [{ ...ready, conversationUrl: 'https://user@www.linkedin.com/messaging/thread/private-thread/' }] },
    { version: 1, entries: [{ ...ready, conversationUrl: 'https://www.linkedin.com/messaging/thread/private-thread/?filter=unread' }] },
    { version: 1, entries: [{ ...ready, conversationUrl: 'https://www.linkedin.com/messaging/thread/private-thread/#private' }] },
    { version: 1, entries: [{ ...ready, conversationUrl: 'https://www.linkedin.com/messaging/thread/private/thread/' }] },
  ];

  for (const value of invalidValues) {
    assert.throws(() => validateOutbox(value), (error) => {
      assert.match(error.message, /invalid/i);
      for (const privateValue of privateValues) assert.doesNotMatch(error.message, new RegExp(privateValue));
      return true;
    });
  }
});

test('validateOutbox accepts a legacy capture marker without recoveryMode for safe migration', () => {
  const { recoveryMode: _recoveryMode, ...legacyCapturePending } = capturePending;
  const value = { version: 1, entries: [legacyCapturePending] };
  assert.equal(validateOutbox(value), value);
});

test('loadOutbox rejects stored non-canonical conversation URLs without exposing them', async () => {
  const privateUrl = 'https://evil.example/private-thread';
  await assert.rejects(loadOutbox({
    outboxPath: '/private/outbox.json',
    fileSystem: readablePrivateFileSystem(JSON.stringify({
      version: 1,
      entries: [{ ...ready, conversationUrl: privateUrl }],
    })),
  }), (error) => /invalid/i.test(error.message) && !error.message.includes(privateUrl));
});

test('loadOutbox reads private state through one no-follow FileHandle', async () => {
  const calls = [];
  const value = { version: 1, entries: [ready] };
  const fileSystem = readablePrivateFileSystem(JSON.stringify(value), { calls });

  assert.deepEqual(await loadOutbox({ outboxPath: '/private/outbox.json', fileSystem }), value);
  assert.deepEqual(calls, [
    ['open', '/private/outbox.json', 0x20000],
    ['handle.stat'],
    ['handle.readFile', 'utf8'],
    ['lstat', '/private/outbox.json'],
    ['handle.close'],
  ]);
});

test('loadOutbox returns an empty outbox only when the file does not exist', async () => {
  await withTempDirectory(async (directory) => {
    assert.deepEqual(
      await loadOutbox({ outboxPath: path.join(directory, 'missing.json') }),
      { version: 1, entries: [] },
    );

    const denied = new Error('private path denied');
    denied.code = 'EACCES';
    await assert.rejects(loadOutbox({
      outboxPath: '/private/outbox.json',
      fileSystem: {
        constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000 },
        open: async () => { throw denied; },
      },
    }), (error) => error.message === 'Private state could not be read securely.'
      && !error.message.includes('private path denied')
      && !error.message.includes('/private/outbox.json'));
  });
});

test('loadOutbox fails closed without O_NOFOLLOW support', async () => {
  await assert.rejects(loadOutbox({
    outboxPath: '/private/outbox.json',
    fileSystem: { constants: { O_RDONLY: 0 }, open: async () => assert.fail() },
  }), (error) => error.message === 'Private state could not be read securely.');
});

test('loadOutbox rejects symlinks, directories, broad permissions, and replacement races safely', async () => {
  await withTempDirectory(async (directory) => {
    const privateContent = 'PRIVATE_OUTBOX_CONTENT=must-not-leak';
    const targetPath = path.join(directory, 'must-not-leak.json');
    const outboxPath = path.join(directory, 'outbox.json');
    await fs.writeFile(targetPath, privateContent, { mode: 0o600 });
    await fs.symlink(targetPath, outboxPath);
    await assert.rejects(loadOutbox({ outboxPath }), (error) => (
      error.message === 'Private state could not be read securely.'
      && !error.message.includes(privateContent)
      && !error.message.includes(directory)
    ));
    await fs.unlink(outboxPath);

    await fs.mkdir(outboxPath);
    await assert.rejects(loadOutbox({ outboxPath }), (error) => (
      error.message === 'Private state could not be read securely.'
    ));
    await fs.rmdir(outboxPath);

    await fs.writeFile(outboxPath, privateContent, { mode: 0o644 });
    await assert.rejects(loadOutbox({ outboxPath }), (error) => (
      error.message === 'Private state could not be read securely.'
      && !error.message.includes(privateContent)
      && !error.message.includes(directory)
    ));
  });

  const privateContent = 'PRIVATE_OUTBOX_CONTENT=must-not-leak';
  await assert.rejects(loadOutbox({
    outboxPath: '/private/outbox.json',
    fileSystem: readablePrivateFileSystem(privateContent, {
      openedStat: privateStat({ ino: 2 }),
      pathStat: privateStat({ ino: 3 }),
    }),
  }), (error) => error.message === 'Private state could not be read securely.'
    && !error.message.includes(privateContent)
    && !error.message.includes('/private/outbox.json'));
});

test('loadOutbox closes once and preserves a primary failure over close failure', async () => {
  const calls = [];
  const privateContent = 'PRIVATE_OUTBOX_CONTENT=must-not-leak';
  await assert.rejects(loadOutbox({
    outboxPath: '/private/outbox.json',
    fileSystem: {
      constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000 },
      open: async () => ({
        stat: async () => privateStat(),
        readFile: async () => { calls.push('read'); throw new Error(privateContent); },
        close: async () => { calls.push('close'); throw new Error('private close failure'); },
      }),
      lstat: async () => { calls.push('lstat'); return privateStat(); },
    },
  }), (error) => error.message === 'Private state could not be read securely.'
    && !error.message.includes(privateContent)
    && !error.message.includes('/private/outbox.json'));
  assert.deepEqual(calls, ['read', 'close']);

  await assert.rejects(loadOutbox({
    outboxPath: '/private/outbox.json',
    fileSystem: {
      constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000 },
      open: async () => ({
        stat: async () => privateStat(),
        readFile: async () => JSON.stringify({ version: 1, entries: [] }),
        close: async () => { throw new Error('private close failure'); },
      }),
      lstat: async () => privateStat(),
    },
  }), (error) => error.message === 'Private state could not be read securely.'
    && !error.message.includes('private close failure')
    && !error.message.includes('/private/outbox.json'));
});

test('loadOutbox rejects corrupt JSON without exposing file contents', async () => {
  const privateFragment = 'private-corrupt-fragment';
  await assert.rejects(loadOutbox({
    outboxPath: '/private/outbox.json',
    fileSystem: readablePrivateFileSystem(`{${privateFragment}`),
  }), (error) => /corrupt/i.test(error.message) && !error.message.includes(privateFragment));
});

test('saveOutbox writes versioned private JSON atomically', async () => {
  await withTempDirectory(async (directory) => {
    const outboxPath = path.join(directory, 'outbox.json');
    const value = { version: 1, entries: [ready] };
    await saveOutbox({ outboxPath, value });
    assert.deepEqual(await loadOutbox({ outboxPath }), value);
    assert.equal((await fs.stat(outboxPath)).mode & 0o777, 0o600);
    assert.equal(await exists(`${outboxPath}.tmp-${process.pid}`), false);
  });
});

test('saveOutbox creates exact mode-0600 state under a restrictive umask', async () => {
  await withTempDirectory(async (directory) => {
    const outboxPath = path.join(directory, 'outbox.json');
    const value = { version: 1, entries: [ready] };
    const previousUmask = process.umask(0o777);
    try {
      await saveOutbox({ outboxPath, value });
    } finally {
      process.umask(previousUmask);
    }

    assert.equal((await fs.stat(outboxPath)).mode & 0o7777, 0o600);
    assert.deepEqual(await loadOutbox({ outboxPath }), value);
  });
});

test('saveOutbox fsyncs the private temporary file before rename and then fsyncs its parent', async () => {
  const calls = [];
  const text = `${JSON.stringify({ version: 1, entries: [ready] }, null, 2)}\n`;
  const temporaryHandle = {
    chmod: async (...args) => { calls.push(['temp.chmod', ...args]); },
    writeFile: async (...args) => { calls.push(['temp.writeFile', ...args]); },
    sync: async () => { calls.push(['temp.sync']); },
    close: async () => { calls.push(['temp.close']); },
  };
  const directoryHandle = {
    sync: async () => { calls.push(['directory.sync']); },
    close: async () => { calls.push(['directory.close']); },
  };
  const fileSystem = {
    open: async (...args) => {
      calls.push(['open', ...args]);
      return args[0].endsWith('.tmp-42') ? temporaryHandle : directoryHandle;
    },
    rename: async (...args) => { calls.push(['rename', ...args]); },
    rm: async (...args) => { calls.push(['rm', ...args]); },
  };

  await saveOutbox({
    outboxPath: '/private/outbox.json',
    value: { version: 1, entries: [ready] },
    fileSystem,
    processId: 42,
  });
  assert.deepEqual(calls, [
    ['open', '/private/outbox.json.tmp-42', 'wx', 0o600],
    ['temp.chmod', 0o600],
    ['temp.writeFile', text, { encoding: 'utf8' }],
    ['temp.sync'],
    ['temp.close'],
    ['rename', '/private/outbox.json.tmp-42', '/private/outbox.json'],
    ['open', '/private', 'r'],
    ['directory.sync'],
    ['directory.close'],
    ['rm', '/private/outbox.json.tmp-42', { force: true }],
  ]);
});

test('saveOutbox validates before opening a file and preserves write errors over cleanup errors', async () => {
  const calls = [];
  const primaryError = new Error('primary-write-failed');
  const fileSystem = {
    open: async (...args) => {
      calls.push(['open', ...args]);
      return {
        chmod: async () => { calls.push(['chmod']); },
        writeFile: async () => { throw primaryError; },
        sync: async () => {},
        close: async () => { calls.push(['close']); throw new Error('cleanup-close-failed'); },
      };
    },
    rm: async (...args) => { calls.push(['rm', ...args]); throw new Error('cleanup-rm-failed'); },
  };

  await assert.rejects(saveOutbox({
    outboxPath: '/private/outbox.json',
    value: { version: 1, entries: [ready] },
    fileSystem,
    processId: 42,
  }), (error) => error === primaryError);
  assert.deepEqual(calls, [
    ['open', '/private/outbox.json.tmp-42', 'wx', 0o600],
    ['chmod'],
    ['close'],
    ['rm', '/private/outbox.json.tmp-42', { force: true }],
  ]);

  calls.length = 0;
  await assert.rejects(saveOutbox({
    outboxPath: '/private/outbox.json',
    value: { version: 1, entries: [{ ...ready, content: undefined }] },
    fileSystem,
  }), /invalid/i);
  assert.deepEqual(calls, []);
});

test('withOutboxLock rejects an overlapping run and removes its lock', async () => {
  await withTempDirectory(async (directory) => {
    const lockPath = path.join(directory, 'outbox.lock');
    let release;
    const first = withOutboxLock({
      lockPath,
      task: async () => new Promise((resolve) => { release = resolve; }),
    });
    await waitUntil(async () => {
      try {
        return (await fs.stat(lockPath)).isDirectory()
          && ((await fs.stat(lockPath)).mode & 0o777) === 0o700;
      } catch {
        return false;
      }
    });
    assert.deepEqual(await fs.readdir(lockPath), []);
    await assert.rejects(withOutboxLock({ lockPath, task: async () => {} }), /already running/i);
    await waitUntil(() => typeof release === 'function');
    release('complete');
    assert.equal(await first, 'complete');
    assert.equal(await exists(lockPath), false);
  });
});

test('withOutboxLock recovers an orphaned stale package lock without a reclaim guard', async () => {
  await withTempDirectory(async (directory) => {
    const lockPath = path.join(directory, 'outbox.lock');
    await fs.mkdir(lockPath, { mode: 0o700 });
    const staleTime = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, staleTime, staleTime);
    await fs.mkdir(`${lockPath}.reclaim`, { mode: 0o700 });

    let ran = false;
    const result = await withOutboxLock({
      lockPath,
      task: async () => { ran = true; return 'reclaimed'; },
    });

    assert.equal(result, 'reclaimed');
    assert.equal(ran, true);
    assert.equal(await exists(lockPath), false);
    assert.equal(await exists(`${lockPath}.reclaim`), true);
  });
});

test('withOutboxLock releases after task failure and preserves the task error', async () => {
  await withTempDirectory(async (directory) => {
    const lockPath = path.join(directory, 'outbox.lock');
    const taskError = new Error('task-failed');
    await assert.rejects(withOutboxLock({
      lockPath,
      task: async () => { throw taskError; },
    }), (error) => error === taskError);
    assert.equal(await exists(lockPath), false);
  });
});

test('withOutboxLock configures proper-lockfile with bounded crash recovery and a private artifact', async () => {
  const calls = [];
  const lockImplementation = async (target, options) => {
    calls.push(['lock', target, options]);
    return async () => { calls.push(['release']); };
  };
  const fileSystem = {
    chmod: async (...args) => { calls.push(['chmod', ...args]); },
  };

  assert.equal(await withOutboxLock({
    lockPath: '/private/sensitive/outbox.lock',
    task: async () => 'done',
    fileSystem,
    lockImplementation,
  }), 'done');
  const options = calls[0][2];
  assert.equal(calls[0][0], 'lock');
  assert.equal(calls[0][1], '/private/sensitive/outbox.lock');
  assert.equal(options.realpath, false);
  assert.equal(options.lockfilePath, '/private/sensitive/outbox.lock');
  assert.equal(options.retries, 0);
  assert.equal(options.stale, 10_000);
  assert.equal(options.update, 2_000);
  assert.equal(typeof options.onCompromised, 'function');
  assert.deepEqual(calls.slice(1), [
    ['chmod', '/private/sensitive/outbox.lock', 0o700],
    ['release'],
  ]);
});

test('withOutboxLock sanitizes contention, compromise, update, and release errors', async () => {
  const privatePath = '/private/sensitive/outbox.lock';
  const fileSystem = { chmod: async () => {} };
  const contention = new Error(`Lock file is already being held at ${privatePath}`);
  contention.code = 'ELOCKED';
  await assert.rejects(withOutboxLock({
    lockPath: privatePath,
    task: async () => assert.fail('must not run'),
    fileSystem,
    lockImplementation: async () => { throw contention; },
  }), (error) => /already running/i.test(error.message) && !error.message.includes(privatePath));

  for (const failure of ['compromised', 'update']) {
    await assert.rejects(withOutboxLock({
      lockPath: privatePath,
      task: async () => 'finished',
      fileSystem,
      lockImplementation: async (_target, options) => {
        options.onCompromised(new Error(`${failure} at ${privatePath}`));
        return async () => {};
      },
    }), (error) => /lock failed/i.test(error.message) && !error.message.includes(privatePath));
  }

  await assert.rejects(withOutboxLock({
    lockPath: privatePath,
    task: async () => 'finished',
    fileSystem,
    lockImplementation: async () => async () => { throw new Error(`release failed at ${privatePath}`); },
  }), (error) => /lock failed/i.test(error.message) && !error.message.includes(privatePath));
});

test('withOutboxLock aborts and awaits a cooperative task before releasing a compromised lock', async () => {
  const privatePath = '/private/sensitive/outbox.lock';
  const events = [];
  let compromise;
  let resumeTask;
  let taskStarted;
  const started = new Promise((resolve) => { taskStarted = resolve; });
  const pause = new Promise((resolve) => { resumeTask = resolve; });
  let mutated = false;

  const pending = withOutboxLock({
    lockPath: privatePath,
    fileSystem: { chmod: async () => { events.push('chmod'); } },
    lockImplementation: async (_target, options) => {
      compromise = options.onCompromised;
      return async () => { events.push('release'); };
    },
    task: async (context) => {
      const signal = context?.signal;
      events.push('task-start');
      taskStarted();
      await pause;
      events.push('task-resumed');
      assert.equal(signal.aborted, true);
      signal.throwIfAborted();
      mutated = true;
    },
  });
  pending.catch(() => {});

  await started;
  compromise(new Error(`lock update failed at ${privatePath}`));
  assert.deepEqual(events, ['chmod', 'task-start']);
  resumeTask();

  await assert.rejects(pending, (error) => /lock failed/i.test(error.message)
    && !error.message.includes(privatePath));
  assert.equal(mutated, false);
  assert.deepEqual(events, ['chmod', 'task-start', 'task-resumed', 'release']);
});

test('all package lock artifacts are ignored without a custom reclaim guard', async () => {
  const gitignore = await fs.readFile(new URL('../.gitignore', import.meta.url), 'utf8');
  const patterns = gitignore.split(/\r?\n/);
  assert.equal(patterns.includes('.linkedin-unread-outbox.lock*'), true);
});
