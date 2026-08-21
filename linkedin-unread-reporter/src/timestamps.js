import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createIdempotencyKey } from './messages.js';
import { validateOutbox } from './outbox.js';

const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(['EINVAL', 'ENOSYS', 'ENOTSUP']);

function checkpoint(signal) {
  signal?.throwIfAborted();
}

async function checkedAwait(signal, operation) {
  checkpoint(signal);
  try {
    return await operation();
  } finally {
    checkpoint(signal);
  }
}

async function closeResultHandle({ resultHandle, signal, primaryError }) {
  let closeError;
  try {
    await resultHandle.close();
  } catch {
    closeError = new Error('Timestamp result close failed.');
  }
  checkpoint(signal);
  if (primaryError) throw primaryError;
  if (closeError) throw closeError;
}

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function removeTimestampSidecars({ workPath, resultPath, fileSystem = fs }) {
  await cleanupPreserving(undefined, [
    async () => fileSystem.rm(workPath, { force: true }),
    async () => fileSystem.rm(resultPath, { force: true }),
  ]);
}

export async function removeTimestampResult({ resultPath, fileSystem = fs }) {
  await fileSystem.rm(resultPath, { force: true });
}

async function readPrivateTimestampSidecar({
  targetPath,
  fileSystem,
  signal,
  validate,
  readFailedMessage,
}) {
  if (typeof targetPath !== 'string' || !targetPath) invalid();
  let resultHandle;
  let openError;
  try {
    resultHandle = await fileSystem.open(
      targetPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    openError = error;
  }
  if (signal?.aborted && resultHandle) {
    await closeResultHandle({ resultHandle, signal });
  }
  checkpoint(signal);
  if (openError) {
    if (openError?.code !== 'ENOENT') throw new Error(readFailedMessage);
    return null;
  }

  let result;
  let primaryError;
  try {
    const openedStat = await checkedAwait(signal, () => resultHandle.stat());
    if (!openedStat.isFile() || (openedStat.mode & 0o777) !== 0o600) {
      throw new Error('Timestamp result permissions are invalid.');
    }
    const text = await checkedAwait(signal, () => resultHandle.readFile('utf8'));
    const pathStat = await checkedAwait(signal, () => fileSystem.lstat(targetPath));
    if (!pathStat.isFile()
      || pathStat.dev !== openedStat.dev
      || pathStat.ino !== openedStat.ino) invalid();
    try {
      result = JSON.parse(text);
    } catch {
      invalid();
    }
    validate(result);
  } catch (error) {
    primaryError = signal?.aborted ? signal.reason : [
      'Timestamp data is invalid.',
      'Timestamp result permissions are invalid.',
    ].includes(error?.message)
      ? error
      : new Error(readFailedMessage);
  }
  await closeResultHandle({ resultHandle, signal, primaryError });
  return result;
}

export async function readTimestampWork({
  workPath,
  fileSystem = fs,
  signal,
}) {
  return readPrivateTimestampSidecar({
    targetPath: workPath,
    fileSystem,
    signal,
    validate: (value) => validateTimestampWork(value),
    readFailedMessage: 'Timestamp work read failed.',
  });
}

export async function readTimestampResult({
  resultPath,
  workId,
  fileSystem = fs,
  signal,
}) {
  if (!isWorkId(workId)) invalid();
  return readPrivateTimestampSidecar({
    targetPath: resultPath,
    fileSystem,
    signal,
    validate: (value) => validateTimestampResult(value, workId),
    readFailedMessage: 'Timestamp result read failed.',
  });
}

export async function waitForTimestampResults({
  resultPath,
  workId,
  timeoutMs,
  pollIntervalMs = 1_000,
  fileSystem = fs,
  signal,
}) {
  if (!Number.isFinite(timeoutMs)
    || timeoutMs < 0
    || !Number.isFinite(pollIntervalMs)
    || pollIntervalMs <= 0) invalid();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    checkpoint(signal);
    const result = await readTimestampResult({
      resultPath,
      workId,
      fileSystem,
      signal,
    });
    if (result) return result;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Timestamp result polling timed out.');
    await checkedAwait(signal, () => abortableDelay(
      Math.min(pollIntervalMs, remaining),
      signal,
    ));
  }
}

async function cleanupPreserving(primaryError, actions) {
  let error = primaryError;
  for (const action of actions) {
    try {
      await action();
    } catch (cleanupError) {
      if (!error) error = cleanupError;
    }
  }
  if (error) throw error;
}

async function syncParentDirectory({ targetPath, fileSystem }) {
  let directoryHandle;
  let primaryError;
  try {
    directoryHandle = await fileSystem.open(path.dirname(targetPath), 'r');
    try {
      await directoryHandle.sync();
    } catch (error) {
      if (!UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error?.code)) throw error;
    }
  } catch (error) {
    primaryError = error;
  }
  await cleanupPreserving(primaryError, [async () => {
    if (directoryHandle) await directoryHandle.close();
  }]);
}

function validateTimestampWork(work) {
  if (!isRecord(work)
    || Object.keys(work).length !== 4
    || work.version !== 1
    || !Number.isInteger(work.attempt)
    || work.attempt < 1
    || work.attempt > 3
    || !isWorkId(work.workId)
    || !Array.isArray(work.items)) invalid();
  const keys = new Set();
  for (const item of work.items) {
    if (!isRecord(item)
      || Object.keys(item).length !== 3
      || typeof item.itemKey !== 'string'
      || !item.itemKey.trim()
      || typeof item.relativeTime !== 'string'
      || !item.relativeTime.trim()
      || !isCanonicalIsoTimestamp(item.scanStartedAt)
      || keys.has(item.itemKey)) invalid();
    keys.add(item.itemKey);
  }
  return work;
}

export async function writeTimestampWork({
  workPath,
  work,
  fileSystem = fs,
  processId = process.pid,
}) {
  validateTimestampWork(work);
  const temporaryPath = `${workPath}.tmp-${processId}`;
  let temporaryHandle;
  let primaryError;
  try {
    temporaryHandle = await fileSystem.open(temporaryPath, 'wx', 0o600);
    await temporaryHandle.chmod(0o600);
    await temporaryHandle.writeFile(`${JSON.stringify(work, null, 2)}\n`, { encoding: 'utf8' });
    await temporaryHandle.sync();
    try {
      await temporaryHandle.close();
    } finally {
      temporaryHandle = null;
    }
    await fileSystem.rename(temporaryPath, workPath);
    await syncParentDirectory({ targetPath: workPath, fileSystem });
  } catch (error) {
    primaryError = error;
  }
  await cleanupPreserving(primaryError, [
    async () => { if (temporaryHandle) await temporaryHandle.close(); },
    async () => fileSystem.rm(temporaryPath, { force: true }),
  ]);
}

function invalid() {
  throw new Error('Timestamp data is invalid.');
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== 'string' || !value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function isWorkId(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function toReadyEntry(entry, sentAt) {
  const { scanStartedAt: _scanStartedAt, ...fields } = entry;
  const ready = {
    ...fields,
    state: 'ready',
    idempotencyKey: createIdempotencyKey({
      linkedinMessageId: entry.linkedinMessageId,
      leadName: entry.leadName,
      sentAt,
      conversationUrl: entry.conversationUrl,
    }),
    sentAt,
    sentAtAccuracy: 'estimated',
  };
  return ready;
}

function validateUniqueReadyIdempotencyKeys(outbox) {
  const keys = new Set();
  for (const entry of outbox.entries) {
    if (entry.state !== 'ready') continue;
    if (keys.has(entry.idempotencyKey)) invalid();
    keys.add(entry.idempotencyKey);
  }
  return outbox;
}

function validateTimestampResult(result, expectedWorkId) {
  if (!isRecord(result)
    || Object.keys(result).length !== 3
    || result.version !== 1
    || !isWorkId(result.workId)
    || result.workId !== expectedWorkId
    || !Array.isArray(result.items)) invalid();
  const items = new Map();
  for (const item of result.items) {
    if (!isRecord(item)
      || Object.keys(item).length !== 2
      || typeof item.itemKey !== 'string'
      || !item.itemKey.trim()
      || !isCanonicalIsoTimestamp(item.sentAt)
      || items.has(item.itemKey)) invalid();
    items.set(item.itemKey, item.sentAt);
  }
  return items;
}

function buildPendingTimestampMapping(outbox) {
  return outbox.entries
    .filter(({ state }) => state === 'timestamp_pending')
    .slice()
    .sort((left, right) => (left.entryId < right.entryId ? -1 : left.entryId > right.entryId ? 1 : 0))
    .map((entry, index) => ({ entry, itemKey: `timestamp-${index + 1}` }));
}

export function applyTimestampResults(outbox, result, { workId } = {}) {
  validateOutbox(outbox);
  if (!isWorkId(workId)) invalid();
  const resultItems = validateTimestampResult(result, workId);
  const pendingMapping = buildPendingTimestampMapping(outbox);
  if (resultItems.size !== pendingMapping.length
    || pendingMapping.some(({ itemKey }) => !resultItems.has(itemKey))) invalid();
  if (pendingMapping.length === 0) return outbox;
  const resultKeyByEntryId = new Map(pendingMapping
    .map(({ entry, itemKey }) => [entry.entryId, itemKey]));

  const next = {
    version: 1,
    entries: outbox.entries.map((entry) => entry.state === 'timestamp_pending'
      ? toReadyEntry(entry, resultItems.get(resultKeyByEntryId.get(entry.entryId)))
      : entry),
  };
  validateOutbox(next);
  return validateUniqueReadyIdempotencyKeys(next);
}

export function applyLocalTimestampFallback(outbox) {
  validateOutbox(outbox);
  const next = {
    version: 1,
    entries: outbox.entries.map((entry) => {
      if (entry.state !== 'timestamp_pending') return entry;
      const sentAt = convertRelativeTime(entry.sentAtRaw, entry.scanStartedAt);
      return sentAt === null ? entry : toReadyEntry(entry, sentAt);
    }),
  };
  validateOutbox(next);
  return validateUniqueReadyIdempotencyKeys(next);
}

export function convertRelativeTime(relativeTime, scanStartedAt) {
  if (typeof scanStartedAt !== 'string') {
    throw new Error('Timestamp scan anchor is invalid.');
  }
  const anchor = new Date(scanStartedAt);
  if (Number.isNaN(anchor.valueOf()) || anchor.toISOString() !== scanStartedAt) {
    throw new Error('Timestamp scan anchor is invalid.');
  }
  if (typeof relativeTime !== 'string') return null;
  const label = relativeTime.trim().toLowerCase();
  if (label === 'now') return anchor.toISOString();
  if (label === 'yesterday') return new Date(anchor.valueOf() - 86_400_000).toISOString();

  const match = /^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)(?:\s+ago)?$/.exec(label);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount)) return null;
  const unit = match[2][0];
  const milliseconds = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit];
  const value = anchor.valueOf() - amount * milliseconds;
  if (!Number.isSafeInteger(value)) return null;
  const converted = new Date(value);
  return Number.isNaN(converted.valueOf()) ? null : converted.toISOString();
}

export function buildTimestampWork(outbox, { attempt, generateWorkId = randomUUID }) {
  validateOutbox(outbox);
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 3) {
    throw new Error('Timestamp attempt is invalid.');
  }
  if (typeof generateWorkId !== 'function') invalid();
  const workId = generateWorkId();
  if (!isWorkId(workId)) invalid();
  return {
    version: 1,
    attempt,
    workId,
    items: buildPendingTimestampMapping(outbox)
      .map(({ entry, itemKey }) => ({
        itemKey,
        relativeTime: entry.sentAtRaw,
        scanStartedAt: entry.scanStartedAt,
      })),
  };
}
