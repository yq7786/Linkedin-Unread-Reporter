import assert from 'node:assert/strict';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyLocalTimestampFallback,
  applyTimestampResults,
  buildTimestampWork,
  convertRelativeTime,
  readTimestampResult,
  readTimestampWork,
  removeTimestampSidecars,
  waitForTimestampResults,
  writeTimestampWork,
} from '../src/timestamps.js';

const timestampPending = {
  entryId: 'entry-1',
  state: 'timestamp_pending',
  leadName: 'Ada Lovelace',
  conversationUrl: 'https://www.linkedin.com/messaging/thread/private-thread/',
  linkedinMessageId: null,
  contentType: 'text',
  content: 'Hello from LinkedIn',
  sentAtRaw: '2h',
  scanStartedAt: '2026-08-19T03:00:00.000Z',
};

const outbox = { version: 1, entries: [timestampPending] };
const workId = '11111111-1111-4111-8111-111111111111';

function timestampResult(items, resultWorkId = workId) {
  return { version: 1, workId: resultWorkId, items };
}

async function withTempDirectory(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'linkedin-timestamps-'));
  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('buildTimestampWork exposes only temporary keys, labels, and scan anchors', () => {
  const work = buildTimestampWork(outbox, { attempt: 1, generateWorkId: () => workId });
  assert.deepEqual(work, {
    version: 1,
    attempt: 1,
    workId,
    items: [{
      itemKey: 'timestamp-1',
      relativeTime: '2h',
      scanStartedAt: '2026-08-19T03:00:00.000Z',
    }],
  });
  assert.doesNotMatch(JSON.stringify(work), /Ada|Hello|messaging\/thread/);
});

test('buildTimestampWork creates a fresh opaque work id for every normalization attempt', () => {
  const workIds = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];
  const generateWorkId = () => workIds.shift();

  const first = buildTimestampWork(outbox, { attempt: 1, generateWorkId });
  const second = buildTimestampWork(outbox, { attempt: 2, generateWorkId });

  assert.equal(first.workId, '11111111-1111-4111-8111-111111111111');
  assert.equal(second.workId, '22222222-2222-4222-8222-222222222222');
  assert.notEqual(first.workId, second.workId);
  assert.doesNotMatch(JSON.stringify([first, second]), /Ada|Hello|messaging\/thread/);
});

test('buildTimestampWork supports exactly three timestamp attempts', () => {
  for (const attempt of [1, 2, 3]) assert.equal(buildTimestampWork(outbox, { attempt }).attempt, attempt);
  for (const attempt of [0, 4, 1.5, '1']) {
    assert.throws(() => buildTimestampWork(outbox, { attempt }), /attempt.*invalid/i);
  }
});

test('buildTimestampWork replaces private entry ids with deterministic opaque keys', () => {
  const value = {
    version: 1,
    entries: [
      {
        ...timestampPending,
        entryId: 'private-z-Ada-Hello-https://www.linkedin.com/messaging/thread/secret/',
        sentAtRaw: '2h',
      },
      {
        ...timestampPending,
        entryId: 'private-a-Grace-Content-https://www.linkedin.com/messaging/thread/other/',
        sentAtRaw: '15m',
      },
    ],
  };
  const work = buildTimestampWork(value, { attempt: 1, generateWorkId: () => workId });
  assert.deepEqual(work.items, [
    {
      itemKey: 'timestamp-1',
      relativeTime: '15m',
      scanStartedAt: '2026-08-19T03:00:00.000Z',
    },
    {
      itemKey: 'timestamp-2',
      relativeTime: '2h',
      scanStartedAt: '2026-08-19T03:00:00.000Z',
    },
  ]);
  assert.doesNotMatch(JSON.stringify(work), /private-|Ada|Hello|Grace|Content|linkedin\.com/);

  const next = applyTimestampResults(value, timestampResult([
      { itemKey: 'timestamp-1', sentAt: '2026-08-19T02:45:00.000Z' },
      { itemKey: 'timestamp-2', sentAt: '2026-08-19T01:00:00.000Z' },
  ]), { workId });
  assert.equal(next.entries[0].sentAt, '2026-08-19T01:00:00.000Z');
  assert.equal(next.entries[1].sentAt, '2026-08-19T02:45:00.000Z');
});

test('convertRelativeTime deterministically supports fixed-anchor relative labels', () => {
  const anchor = '2026-08-19T03:00:00.000Z';
  assert.equal(convertRelativeTime('now', anchor), anchor);
  assert.equal(convertRelativeTime('15m', anchor), '2026-08-19T02:45:00.000Z');
  assert.equal(convertRelativeTime('2h', anchor), '2026-08-19T01:00:00.000Z');
  assert.equal(convertRelativeTime('3d', anchor), '2026-08-16T03:00:00.000Z');
  assert.equal(convertRelativeTime('2w', anchor), '2026-08-05T03:00:00.000Z');
  assert.equal(convertRelativeTime('yesterday', anchor), '2026-08-18T03:00:00.000Z');
});

test('convertRelativeTime returns null for unsupported labels and rejects invalid anchors safely', () => {
  assert.equal(convertRelativeTime('last Tuesday', '2026-08-19T03:00:00.000Z'), null);
  assert.equal(convertRelativeTime('14300000w', '2026-08-19T03:00:00.000Z'), null);
  assert.throws(
    () => convertRelativeTime('2h', 'private-invalid-anchor'),
    (error) => /anchor/i.test(error.message) && !error.message.includes('private-invalid-anchor'),
  );
  assert.throws(
    () => convertRelativeTime('2h', Symbol('private-anchor')),
    (error) => /anchor/i.test(error.message) && !error.message.includes('private-anchor'),
  );
});

test('applyTimestampResults promotes exact pending coverage and rejects stale replay', () => {
  const result = timestampResult([
    { itemKey: 'timestamp-1', sentAt: '2026-08-19T01:00:00.000Z' },
  ]);
  const next = applyTimestampResults(outbox, result, { workId });
  assert.deepEqual(Object.keys(next.entries[0]).sort(), [
    'content', 'contentType', 'conversationUrl', 'entryId', 'idempotencyKey', 'leadName',
    'linkedinMessageId', 'sentAt', 'sentAtAccuracy', 'sentAtRaw', 'state',
  ]);
  assert.equal(next.entries[0].state, 'ready');
  assert.equal(next.entries[0].sentAtAccuracy, 'estimated');
  assert.equal(next.entries[0].sentAt, '2026-08-19T01:00:00.000Z');
  assert.match(next.entries[0].idempotencyKey, /^sha256:[a-f0-9]{64}$/);
  assert.throws(() => applyTimestampResults(next, result, { workId }), /invalid/i);
  assert.equal(applyTimestampResults(next, timestampResult([]), { workId }), next);
  assert.equal(outbox.entries[0].state, 'timestamp_pending');
});

test('applyTimestampResults rejects an equal-sized valid result left by a previous run', () => {
  const currentWork = buildTimestampWork(outbox, {
    attempt: 1,
    generateWorkId: () => '22222222-2222-4222-8222-222222222222',
  });
  const staleResult = {
    version: 1,
    workId: '11111111-1111-4111-8111-111111111111',
    items: [{ itemKey: 'timestamp-1', sentAt: '2026-08-19T01:00:00.000Z' }],
  };

  assert.throws(
    () => applyTimestampResults(outbox, staleResult, { workId: currentWork.workId }),
    /invalid/i,
  );
  assert.equal(outbox.entries[0].state, 'timestamp_pending');
});

test('applyTimestampResults rejects missing, malformed, and mismatched work ids', () => {
  const expectedWorkId = '22222222-2222-4222-8222-222222222222';
  const items = [{ itemKey: 'timestamp-1', sentAt: '2026-08-19T01:00:00.000Z' }];
  for (const result of [
    { version: 1, items },
    { version: 1, workId: 'not-a-work-id', items },
    { version: 1, workId: '11111111-1111-4111-8111-111111111111', items },
  ]) {
    assert.throws(
      () => applyTimestampResults(outbox, result, { workId: expectedWorkId }),
      /invalid/i,
    );
  }
});

test('applyTimestampResults rejects malformed schemas, duplicate keys, and non-exact coverage safely', () => {
  const invalidResults = [
    timestampResult([]),
    { version: 2, workId, items: [{ itemKey: 'timestamp-1', sentAt: '2026-08-19T01:00:00.000Z' }] },
    timestampResult([{ itemKey: 'entry-private-unknown', sentAt: '2026-08-19T01:00:00.000Z' }]),
    timestampResult([
      { itemKey: 'timestamp-1', sentAt: '2026-08-19T01:00:00.000Z' },
      { itemKey: 'timestamp-1', sentAt: '2026-08-19T01:00:00.000Z' },
    ]),
    timestampResult([{ itemKey: 'timestamp-1', sentAt: '2026-08-19T01:00:00Z' }]),
    timestampResult([{ itemKey: 'timestamp-1', sentAt: 'private-invalid-time' }]),
    timestampResult([{ itemKey: 'timestamp-1', sentAt: '2026-08-19T01:00:00.000Z', extra: true }]),
    { ...timestampResult([{ itemKey: 'timestamp-1', sentAt: '2026-08-19T01:00:00.000Z' }]), extra: true },
  ];
  for (const result of invalidResults) {
    assert.throws(
      () => applyTimestampResults(outbox, result, { workId }),
      (error) => /invalid/i.test(error.message)
        && !/entry-private|private-invalid/.test(error.message),
    );
  }
});

test('applyTimestampResults rejects colliding fallback idempotency keys without partial promotion', () => {
  const collidingOutbox = {
    version: 1,
    entries: [
      timestampPending,
      {
        ...timestampPending,
        entryId: 'entry-2',
        content: 'Different private content',
      },
    ],
  };
  const original = structuredClone(collidingOutbox);
  assert.throws(() => applyTimestampResults(collidingOutbox, timestampResult([
      { itemKey: 'timestamp-1', sentAt: '2026-08-19T01:00:00.000Z' },
      { itemKey: 'timestamp-2', sentAt: '2026-08-19T01:00:00.000Z' },
  ]), { workId }), (error) => /invalid/i.test(error.message)
    && !/Ada|Different|entry-/.test(error.message));
  assert.deepEqual(collidingOutbox, original);
});

test('applyTimestampResults rejects multi-item subsets and stale results when none are pending', () => {
  const twoPending = {
    version: 1,
    entries: [
      timestampPending,
      { ...timestampPending, entryId: 'entry-2', linkedinMessageId: 'message-2' },
    ],
  };
  assert.throws(() => applyTimestampResults(twoPending, timestampResult([
    { itemKey: 'timestamp-1', sentAt: '2026-08-19T01:00:00.000Z' },
  ]), { workId }), /invalid/i);
  assert.equal(twoPending.entries.every(({ state }) => state === 'timestamp_pending'), true);

  const readyOutbox = applyTimestampResults(outbox, timestampResult([
    { itemKey: 'timestamp-1', sentAt: '2026-08-19T01:00:00.000Z' },
  ]), { workId });
  assert.throws(() => applyTimestampResults(readyOutbox, timestampResult([
    { itemKey: 'timestamp-1', sentAt: '2026-08-19T01:00:00.000Z' },
  ]), { workId }), /invalid/i);
});

test('applyLocalTimestampFallback promotes supported labels and leaves unsupported labels pending', () => {
  const value = {
    version: 1,
    entries: [
      timestampPending,
      { ...timestampPending, entryId: 'entry-unsupported', sentAtRaw: 'last Tuesday' },
    ],
  };
  const next = applyLocalTimestampFallback(value);
  assert.equal(next.entries[0].state, 'ready');
  assert.equal(next.entries[0].sentAt, '2026-08-19T01:00:00.000Z');
  assert.equal(next.entries[1].state, 'timestamp_pending');
  assert.deepEqual(next.entries[1], value.entries[1]);
});

test('applyLocalTimestampFallback rejects colliding fallback keys without partial promotion', () => {
  const collidingOutbox = {
    version: 1,
    entries: [
      timestampPending,
      { ...timestampPending, entryId: 'entry-2', content: 'Different private content' },
    ],
  };
  const original = structuredClone(collidingOutbox);
  assert.throws(
    () => applyLocalTimestampFallback(collidingOutbox),
    (error) => /invalid/i.test(error.message) && !/Ada|Different|entry-/.test(error.message),
  );
  assert.deepEqual(collidingOutbox, original);
});

test('readTimestampWork and readTimestampResult return null when sidecars are absent', async () => {
  await withTempDirectory(async (directory) => {
    assert.equal(await readTimestampWork({ workPath: path.join(directory, 'work.json') }), null);
    assert.equal(await readTimestampResult({
      resultPath: path.join(directory, 'result.json'),
      workId,
    }), null);
  });
});

test('readTimestampWork and readTimestampResult load a matching private sidecar once', async () => {
  await withTempDirectory(async (directory) => {
    const workPath = path.join(directory, 'work.json');
    const resultPath = path.join(directory, 'result.json');
    const work = buildTimestampWork(outbox, { attempt: 1, generateWorkId: () => workId });
    const result = timestampResult([{ itemKey: 'timestamp-1', sentAt: '2026-08-19T01:00:00.000Z' }]);
    await writeTimestampWork({ workPath, work });
    await fs.writeFile(resultPath, `${JSON.stringify(result)}\n`, { mode: 0o600 });

    assert.deepEqual(await readTimestampWork({ workPath }), work);
    assert.deepEqual(await readTimestampResult({ resultPath, workId }), result);
  });
});

test('writeTimestampWork atomically writes a durable private sidecar', async () => {
  await withTempDirectory(async (directory) => {
    const workPath = path.join(directory, 'work.json');
    const work = buildTimestampWork(outbox, { attempt: 3 });
    await writeTimestampWork({ workPath, work });
    assert.deepEqual(JSON.parse(await fs.readFile(workPath, 'utf8')), work);
    assert.equal((await fs.stat(workPath)).mode & 0o777, 0o600);
    await assert.rejects(fs.access(`${workPath}.tmp-${process.pid}`));
  });
});

test('writeTimestampWork enforces mode 0600 even under a restrictive process umask', async () => {
  await withTempDirectory(async (directory) => {
    const previousUmask = process.umask(0o777);
    try {
      const workPath = path.join(directory, 'work.json');
      await writeTimestampWork({
        workPath,
        work: buildTimestampWork(outbox, { attempt: 1 }),
      });
      assert.equal((await fs.stat(workPath)).mode & 0o777, 0o600);
    } finally {
      process.umask(previousUmask);
    }
  });
});

test('writeTimestampWork fsyncs before rename, fsyncs the parent, and preserves primary errors', async () => {
  const calls = [];
  const primaryError = new Error('primary-write-failed');
  const temporaryHandle = {
    chmod: async () => {},
    writeFile: async () => { throw primaryError; },
    sync: async () => { calls.push(['temp.sync']); },
    close: async () => { calls.push(['temp.close']); throw new Error('cleanup-close-failed'); },
  };
  const fileSystem = {
    open: async (...args) => { calls.push(['open', ...args]); return temporaryHandle; },
    rename: async (...args) => { calls.push(['rename', ...args]); },
    rm: async (...args) => { calls.push(['rm', ...args]); throw new Error('cleanup-rm-failed'); },
  };
  await assert.rejects(writeTimestampWork({
    workPath: '/private/work.json',
    work: buildTimestampWork(outbox, { attempt: 1 }),
    fileSystem,
    processId: 42,
  }), (error) => error === primaryError);
  assert.deepEqual(calls, [
    ['open', '/private/work.json.tmp-42', 'wx', 0o600],
    ['temp.close'],
    ['rm', '/private/work.json.tmp-42', { force: true }],
  ]);
});

test('waitForTimestampResults polls for and validates a private atomic result sidecar', async () => {
  await withTempDirectory(async (directory) => {
    const resultPath = path.join(directory, 'results.json');
    const temporaryPath = `${resultPath}.tmp-agent`;
    const result = timestampResult([
      { itemKey: 'entry-1', sentAt: '2026-08-19T01:00:00.000Z' },
    ]);
    const pending = waitForTimestampResults({
      resultPath, workId, timeoutMs: 500, pollIntervalMs: 1,
    });
    await fs.writeFile(temporaryPath, JSON.stringify(result), { mode: 0o600 });
    await fs.rename(temporaryPath, resultPath);
    assert.deepEqual(await pending, result);
    assert.equal((await fs.stat(resultPath)).mode & 0o777, 0o600);
  });
});

test('waitForTimestampResults rejects timeouts and malformed or non-private results safely', async () => {
  await withTempDirectory(async (directory) => {
    const missingPath = path.join(directory, 'private-missing-result.json');
    await assert.rejects(
      waitForTimestampResults({ resultPath: missingPath, workId, timeoutMs: 3, pollIntervalMs: 1 }),
      (error) => /timed out/i.test(error.message) && !error.message.includes(missingPath),
    );

    const resultPath = path.join(directory, 'result.json');
    await fs.writeFile(resultPath, JSON.stringify(timestampResult([
      { itemKey: 'entry-private', sentAt: 'private-time' },
    ])), { mode: 0o600 });
    await assert.rejects(
      waitForTimestampResults({ resultPath, workId, timeoutMs: 20, pollIntervalMs: 1 }),
      (error) => /invalid/i.test(error.message) && !/entry-private|private-time/.test(error.message),
    );

    await fs.writeFile(resultPath, JSON.stringify(timestampResult([])), { mode: 0o644 });
    await fs.chmod(resultPath, 0o644);
    await assert.rejects(
      waitForTimestampResults({ resultPath, workId, timeoutMs: 20, pollIntervalMs: 1 }),
      /permissions.*invalid/i,
    );
  });
});

test('waitForTimestampResults stops immediately when the lock aborts during polling', async () => {
  const controller = new AbortController();
  const compromise = new Error('Outbox lock failed.');
  let openCalls = 0;
  let sleepReached = false;
  const fileSystem = {
    open: async () => {
      openCalls += 1;
      controller.abort(compromise);
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
  };

  const pending = waitForTimestampResults({
    resultPath: '/private/result.json',
    workId,
    timeoutMs: 5,
    pollIntervalMs: 1,
    fileSystem,
    signal: controller.signal,
  }).finally(() => { sleepReached = openCalls > 1; });

  await assert.rejects(pending, compromise);
  assert.equal(openCalls, 1);
  assert.equal(sleepReached, false);
});

test('waitForTimestampResults closes a handle acquired as the lock becomes compromised', async () => {
  const controller = new AbortController();
  const compromise = new Error('Outbox lock failed.');
  let closeCalls = 0;
  const handle = {
    close: async () => { closeCalls += 1; },
  };

  await assert.rejects(waitForTimestampResults({
    resultPath: '/private/result.json',
    workId,
    timeoutMs: 20,
    signal: controller.signal,
    fileSystem: {
      open: async () => {
        controller.abort(compromise);
        return handle;
      },
    },
  }), compromise);

  assert.equal(closeCalls, 1);
});

test('waitForTimestampResults uses one no-follow read handle and validates the same file', async () => {
  const calls = [];
  const result = timestampResult([]);
  const stat = { isFile: () => true, mode: 0o100600, dev: 7, ino: 11 };
  const handle = {
    stat: async () => { calls.push(['handle.stat']); return stat; },
    readFile: async (...args) => { calls.push(['handle.readFile', ...args]); return JSON.stringify(result); },
    close: async () => { calls.push(['handle.close']); },
  };
  const fileSystem = {
    open: async (...args) => { calls.push(['open', ...args]); return handle; },
    lstat: async (...args) => { calls.push(['lstat', ...args]); return stat; },
  };
  assert.deepEqual(await waitForTimestampResults({
    resultPath: '/private/result.json',
    workId,
    timeoutMs: 20,
    fileSystem,
  }), result);
  assert.deepEqual(calls, [
    ['open', '/private/result.json', fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW],
    ['handle.stat'],
    ['handle.readFile', 'utf8'],
    ['lstat', '/private/result.json'],
    ['handle.close'],
  ]);
});

test('waitForTimestampResults rejects symlinks and replacement races without exposing paths', async () => {
  await withTempDirectory(async (directory) => {
    const targetPath = path.join(directory, 'target-private.json');
    const resultPath = path.join(directory, 'result-private.json');
    await fs.writeFile(targetPath, JSON.stringify(timestampResult([])), { mode: 0o600 });
    await fs.symlink(targetPath, resultPath);
    await assert.rejects(
      waitForTimestampResults({ resultPath, workId, timeoutMs: 20, pollIntervalMs: 1 }),
      (error) => /read failed/i.test(error.message) && !error.message.includes(resultPath),
    );
  });

  const openedStat = { isFile: () => true, mode: 0o100600, dev: 7, ino: 11 };
  const replacementStat = { isFile: () => true, mode: 0o100600, dev: 7, ino: 12 };
  await assert.rejects(waitForTimestampResults({
    resultPath: '/private/replaced-result.json',
    workId,
    timeoutMs: 20,
    fileSystem: {
      open: async () => ({
        stat: async () => openedStat,
        readFile: async () => JSON.stringify(timestampResult([])),
        close: async () => {},
      }),
      lstat: async () => replacementStat,
    },
  }), (error) => /invalid/i.test(error.message) && !error.message.includes('/private/'));
});

test('waitForTimestampResults closes its handle while preserving the primary read error', async () => {
  const calls = [];
  await assert.rejects(waitForTimestampResults({
    resultPath: '/private/result.json',
    workId,
    timeoutMs: 20,
    fileSystem: {
      open: async () => ({
        stat: async () => ({ isFile: () => true, mode: 0o100600, dev: 7, ino: 11 }),
        readFile: async () => { throw new Error('private-primary-read-error'); },
        close: async () => { calls.push('close'); throw new Error('private-close-error'); },
      }),
      lstat: async () => assert.fail('must not inspect after failed read'),
    },
  }), (error) => /read failed/i.test(error.message)
    && !/private-primary|private-close|\/private\//.test(error.message));
  assert.deepEqual(calls, ['close']);
});

test('removeTimestampSidecars removes both files and preserves the first cleanup error', async () => {
  await withTempDirectory(async (directory) => {
    const workPath = path.join(directory, 'work.json');
    const resultPath = path.join(directory, 'result.json');
    await fs.writeFile(workPath, 'private');
    await fs.writeFile(resultPath, 'private');
    await removeTimestampSidecars({ workPath, resultPath });
    await assert.rejects(fs.access(workPath));
    await assert.rejects(fs.access(resultPath));
  });

  const calls = [];
  const primaryError = new Error('work-remove-failed');
  await assert.rejects(removeTimestampSidecars({
    workPath: '/private/work.json',
    resultPath: '/private/result.json',
    fileSystem: {
      rm: async (...args) => {
        calls.push(args);
        if (args[0].endsWith('work.json')) throw primaryError;
        throw new Error('result-remove-failed');
      },
    },
  }), (error) => error === primaryError);
  assert.deepEqual(calls, [
    ['/private/work.json', { force: true }],
    ['/private/result.json', { force: true }],
  ]);
});
