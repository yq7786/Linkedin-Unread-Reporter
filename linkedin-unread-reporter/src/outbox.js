import fs from 'node:fs/promises';
import path from 'node:path';
import properLockfile from 'proper-lockfile';

import { readPrivateFile } from './private-file.js';

const COMMON_FIELDS = ['entryId', 'state', 'leadName', 'conversationUrl'];
const CAPTURE_MARKER_BASE_FIELDS = [
  ...COMMON_FIELDS, 'expectedUnreadCount', 'firstFailureAt', 'attemptCount',
];
const ENTRY_FIELDS = {
  preopen_pending: new Set(CAPTURE_MARKER_BASE_FIELDS),
  capture_pending: new Set([...CAPTURE_MARKER_BASE_FIELDS, 'recoveryMode']),
  timestamp_pending: new Set([
    ...COMMON_FIELDS, 'linkedinMessageId', 'contentType', 'content', 'sentAtRaw', 'scanStartedAt',
  ]),
  ready: new Set([
    ...COMMON_FIELDS,
    'idempotencyKey',
    'linkedinMessageId',
    'contentType',
    'content',
    'sentAt',
    'sentAtRaw',
    'sentAtAccuracy',
  ]),
};
const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(['EINVAL', 'ENOSYS', 'ENOTSUP']);

export class OutboxValidationError extends Error {
  constructor() {
    super('Outbox data is invalid.');
    this.name = 'OutboxValidationError';
  }
}

function invalid() {
  throw new OutboxValidationError();
}

function alreadyRunning() {
  return new Error('LinkedIn unread reporter is already running.');
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoTimestamp(value) {
  if (!isNonEmptyString(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function isCanonicalConversationUrl(value) {
  if (!isNonEmptyString(value)) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:'
    && url.hostname === 'www.linkedin.com'
    && url.port === ''
    && url.username === ''
    && url.password === ''
    && url.search === ''
    && url.hash === ''
    && /^\/messaging\/thread\/[^/]+\/$/.test(url.pathname)
    && url.toString() === value;
}

function hasExactFields(entry, allowedFields) {
  return Object.keys(entry).every((field) => allowedFields.has(field));
}

function validateCommonFields(entry) {
  if (!isNonEmptyString(entry.entryId)
    || !isNonEmptyString(entry.leadName)
    || !isCanonicalConversationUrl(entry.conversationUrl)) invalid();
}

function validateCaptureMarker(entry) {
  if (!hasExactFields(entry, ENTRY_FIELDS[entry.state])
    || !isIsoTimestamp(entry.firstFailureAt)
    || !Number.isInteger(entry.attemptCount)
    || entry.attemptCount < 1) invalid();
  if (Object.hasOwn(entry, 'expectedUnreadCount')
    && entry.expectedUnreadCount !== null
    && (!Number.isInteger(entry.expectedUnreadCount) || entry.expectedUnreadCount < 1)) invalid();
  // A missing mode is accepted only so startup can migrate legacy markers safely.
  if (entry.state === 'capture_pending'
    && Object.hasOwn(entry, 'recoveryMode')
    && entry.recoveryMode !== 'direct') invalid();
}

function validateMessageFields(entry) {
  if (entry.linkedinMessageId !== null && !isNonEmptyString(entry.linkedinMessageId)) invalid();
  if (!isNonEmptyString(entry.contentType)
    || !isNonEmptyString(entry.content)
    || !isNonEmptyString(entry.sentAtRaw)) invalid();
}

function validateTimestampPending(entry) {
  if (!hasExactFields(entry, ENTRY_FIELDS.timestamp_pending)) invalid();
  validateMessageFields(entry);
  if (!isIsoTimestamp(entry.scanStartedAt)) invalid();
}

function validateReady(entry) {
  if (!hasExactFields(entry, ENTRY_FIELDS.ready)) invalid();
  validateMessageFields(entry);
  if (!isNonEmptyString(entry.idempotencyKey)
    || !isIsoTimestamp(entry.sentAt)
    || !['exact', 'estimated'].includes(entry.sentAtAccuracy)) invalid();
}

function validateEntry(entry) {
  if (!isRecord(entry)
    || typeof entry.state !== 'string'
    || !Object.hasOwn(ENTRY_FIELDS, entry.state)) invalid();
  validateCommonFields(entry);
  if (entry.state === 'preopen_pending' || entry.state === 'capture_pending') {
    validateCaptureMarker(entry);
  }
  if (entry.state === 'timestamp_pending') validateTimestampPending(entry);
  if (entry.state === 'ready') validateReady(entry);
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

async function syncParentDirectory({ outboxPath, fileSystem }) {
  let directoryHandle;
  let primaryError;
  try {
    directoryHandle = await fileSystem.open(path.dirname(outboxPath), 'r');
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

function lockFailed() {
  return new Error('Outbox lock failed.');
}

function throwIfAborted(signal) {
  if (signal.aborted) throw signal.reason;
}

export function createEmptyOutbox() {
  return { version: 1, entries: [] };
}

export function validateOutbox(value) {
  if (!isRecord(value)
    || Object.keys(value).length !== 2
    || !Object.hasOwn(value, 'version')
    || !Object.hasOwn(value, 'entries')
    || value.version !== 1
    || !Array.isArray(value.entries)) invalid();
  const entryIds = new Set();
  for (const entry of value.entries) {
    validateEntry(entry);
    if (entryIds.has(entry.entryId)) invalid();
    entryIds.add(entry.entryId);
  }
  return value;
}

export async function loadOutbox({ outboxPath, fileSystem = fs }) {
  const text = await readPrivateFile({
    filePath: outboxPath,
    fileSystem,
    errorMessage: 'Private state could not be read securely.',
  });
  if (text === null) return createEmptyOutbox();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Outbox JSON is corrupt.');
  }
  return validateOutbox(value);
}

export async function saveOutbox({ outboxPath, value, fileSystem = fs, processId = process.pid }) {
  validateOutbox(value);
  const temporaryPath = `${outboxPath}.tmp-${processId}`;
  let temporaryHandle;
  let primaryError;
  try {
    temporaryHandle = await fileSystem.open(temporaryPath, 'wx', 0o600);
    await temporaryHandle.chmod(0o600);
    await temporaryHandle.writeFile(`${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' });
    await temporaryHandle.sync();
    try {
      await temporaryHandle.close();
    } finally {
      temporaryHandle = null;
    }
    await fileSystem.rename(temporaryPath, outboxPath);
    await syncParentDirectory({ outboxPath, fileSystem });
  } catch (error) {
    primaryError = error;
  }
  await cleanupPreserving(primaryError, [
    async () => { if (temporaryHandle) await temporaryHandle.close(); },
    async () => fileSystem.rm(temporaryPath, { force: true }),
  ]);
}

export async function withOutboxLock({
  lockPath,
  task,
  fileSystem = fs,
  lockImplementation = properLockfile.lock,
}) {
  const controller = new AbortController();
  const { signal } = controller;
  let compromiseError;
  let release;
  try {
    release = await lockImplementation(lockPath, {
      realpath: false,
      lockfilePath: lockPath,
      retries: 0,
      stale: 10_000,
      update: 2_000,
      onCompromised: () => {
        compromiseError ||= lockFailed();
        controller.abort(compromiseError);
      },
    });
  } catch (error) {
    if (error?.code === 'ELOCKED') throw alreadyRunning();
    throw lockFailed();
  }

  let result;
  let primaryError;
  try {
    throwIfAborted(signal);
    await fileSystem.chmod(lockPath, 0o700);
    throwIfAborted(signal);
    try {
      result = await task({ signal });
    } catch (error) {
      primaryError = signal.aborted ? signal.reason : error;
    }
    if (!primaryError) {
      try {
        throwIfAborted(signal);
      } catch (error) {
        primaryError = error;
      }
    }
  } catch {
    primaryError = signal.aborted ? signal.reason : lockFailed();
  }
  try {
    await release();
  } catch {
    if (!primaryError) primaryError = lockFailed();
  }
  if (primaryError) throw primaryError;
  return result;
}
