import { isDeepStrictEqual } from 'node:util';

import { loadOutbox, saveOutbox, validateOutbox, withOutboxLock } from './outbox.js';
import { deliverReadyEntries, postPortalBatch } from './portal.js';
import {
  applyLocalTimestampFallback,
  applyTimestampResults,
  buildTimestampWork,
  removeTimestampSidecars,
  waitForTimestampResults,
  writeTimestampWork,
} from './timestamps.js';

const MAX_TIMESTAMP_ATTEMPTS = 3;
const DELIVERY_COUNT_FIELDS = ['created', 'duplicate', 'assumedDuplicate'];
const CAPTURE_COUNT_FIELDS = [
  'processedConversations', 'capturedMessages', 'pendingRecovery', 'pendingTimestamps',
];

function invalidDependency() {
  throw new Error('Workflow dependency output is invalid.');
}

function checkpoint(signal) {
  signal.throwIfAborted();
}

async function checkedAwait(signal, operation) {
  checkpoint(signal);
  try {
    return await operation();
  } finally {
    checkpoint(signal);
  }
}

function checkedCall(signal, operation) {
  checkpoint(signal);
  try {
    return operation();
  } finally {
    checkpoint(signal);
  }
}

async function cleanupPreservingPrimary(signal, primaryError, operation) {
  let cleanupError;
  try {
    await operation();
  } catch (error) {
    cleanupError = error;
  }
  checkpoint(signal);
  if (cleanupError) throw primaryError || cleanupError;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function frozenOutbox(outbox) {
  return deepFreeze(structuredClone(outbox));
}

function validatedOutbox(value) {
  try {
    validateOutbox(value);
  } catch {
    invalidDependency();
  }
  return structuredClone(value);
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateCounts(value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidDependency();
  for (const field of fields) if (!isCount(value[field])) invalidDependency();
  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}

function addCounts(left, right, fields) {
  const result = { ...left };
  for (const field of fields) {
    const sum = left[field] + right[field];
    if (!isCount(sum)) invalidDependency();
    result[field] = sum;
  }
  return result;
}

function validateDeliveryResult(value, readyCount) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidDependency();
  const outbox = validatedOutbox(value.outbox);
  const counts = validateCounts(value.counts, DELIVERY_COUNT_FIELDS);
  if (Object.values(counts).reduce((sum, count) => sum + count, 0) !== readyCount) {
    invalidDependency();
  }
  return { outbox, counts };
}

function validateCaptureResult(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidDependency();
  return {
    outbox: validatedOutbox(value.outbox),
    counts: validateCounts(value, CAPTURE_COUNT_FIELDS),
  };
}

function pendingCount(outbox, state) {
  return outbox.entries.filter((entry) => entry.state === state).length;
}

function timestampPendingError(count) {
  return new Error(`${count} timestamp item(s) remain pending.`);
}

function normalizeNow(value) {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) invalidDependency();
  return new Date(value.valueOf());
}

export async function runPortalWorkflow({
  config,
  captureNew = true,
  withLock = withOutboxLock,
  load = loadOutbox,
  save = saveOutbox,
  deliver = deliverReadyEntries,
  capture,
  fetchImpl = globalThis.fetch,
  writeWork = writeTimestampWork,
  waitForResults = waitForTimestampResults,
  removeSidecars = removeTimestampSidecars,
  notifyTimestampWork = () => {},
  now = () => new Date(),
}) {
  if (typeof capture !== 'function') {
    throw new Error('Workflow capture dependency is invalid.');
  }

  return withLock({
    lockPath: config.outboxLockPath,
    task: async ({ signal }) => {
      let outbox = validatedOutbox(
        await checkedAwait(signal, () => load({ outboxPath: config.outboxPath })),
      );
      let lastPersistedOutbox = structuredClone(outbox);
      const nowValue = checkedCall(signal, now);
      checkpoint(signal);
      const scanStartedAt = normalizeNow(nowValue);
      let deliveryCounts = { created: 0, duplicate: 0, assumedDuplicate: 0 };
      let processedConversations = 0;
      let capturedMessages = 0;

      const persist = async (value) => {
        checkpoint(signal);
        const validated = validatedOutbox(value);
        if (isDeepStrictEqual(validated, lastPersistedOutbox)) return;
        await checkedAwait(signal, () => save({
          outboxPath: config.outboxPath,
          value: structuredClone(validated),
        }));
        checkpoint(signal);
        lastPersistedOutbox = structuredClone(validated);
      };

      const adopt = async (value) => {
        checkpoint(signal);
        const validated = validatedOutbox(value);
        await persist(validated);
        checkpoint(signal);
        outbox = validated;
      };

      const deliverCurrent = async () => {
        const readyCount = pendingCount(outbox, 'ready');
        if (readyCount === 0) return;
        checkpoint(signal);
        const rawResult = await checkedAwait(signal, () => deliver({
          outbox: frozenOutbox(outbox),
          capturedAt: new Date(scanStartedAt.valueOf()),
          postBatch: ({ messages, capturedAt }) => {
            return checkedCall(signal, () => postPortalBatch({
              webhookUrl: config.portalWebhookUrl,
              callSecret: config.portalCallSecret,
              messages: structuredClone(messages),
              capturedAt: new Date(capturedAt.valueOf()),
              fetchImpl,
            }));
          },
          signal,
        }));
        const result = validateDeliveryResult(rawResult, readyCount);
        await adopt(result.outbox);
        checkpoint(signal);
        deliveryCounts = addCounts(
          deliveryCounts,
          result.counts,
          DELIVERY_COUNT_FIELDS,
        );
      };

      const normalizePendingTimestamps = async () => {
        const count = pendingCount(outbox, 'timestamp_pending');
        if (count === 0) return;

        for (let attempt = 1; attempt <= MAX_TIMESTAMP_ATTEMPTS; attempt += 1) {
          checkpoint(signal);
          const work = buildTimestampWork(outbox, { attempt });
          try {
            await checkedAwait(signal, () => writeWork({
              workPath: config.timestampWorkPath,
              work: structuredClone(work),
            }));
            checkedCall(signal, () => notifyTimestampWork({ count, attempt }));
          } catch (error) {
            await cleanupPreservingPrimary(signal, error, () => removeSidecars({
              workPath: config.timestampWorkPath,
              resultPath: config.timestampResultPath,
            }));
            throw error;
          }

          let normalized;
          try {
            const result = await checkedAwait(signal, () => waitForResults({
              resultPath: config.timestampResultPath,
              timeoutMs: config.authTimeoutMs,
              signal,
            }));
            checkpoint(signal);
            normalized = applyTimestampResults(outbox, result);
            checkpoint(signal);
          } catch (error) {
            await cleanupPreservingPrimary(signal, error, () => removeSidecars({
              workPath: config.timestampWorkPath,
              resultPath: config.timestampResultPath,
            }));
            continue;
          }

          try {
            await adopt(normalized);
          } catch (error) {
            await cleanupPreservingPrimary(signal, error, () => removeSidecars({
              workPath: config.timestampWorkPath,
              resultPath: config.timestampResultPath,
            }));
            throw error;
          }
          await cleanupPreservingPrimary(signal, undefined, () => removeSidecars({
            workPath: config.timestampWorkPath,
            resultPath: config.timestampResultPath,
          }));
          return;
        }

        checkpoint(signal);
        const fallback = applyLocalTimestampFallback(outbox);
        await adopt(fallback);
        const unsupported = pendingCount(outbox, 'timestamp_pending');
        if (unsupported > 0) throw timestampPendingError(unsupported);
      };

      const runCapturePhase = async ({ recoverPending, discoverNew }) => {
        checkpoint(signal);
        const rawResult = await checkedAwait(signal, () => capture({
          outbox: frozenOutbox(outbox),
          saveOutbox: persist,
          unreadUrl: config.unreadUrl,
          scanStartedAt: new Date(scanStartedAt.valueOf()),
          cap: config.maxUnreadConversations,
          authTimeoutMs: config.authTimeoutMs,
          recoverPending,
          captureNew: discoverNew,
          signal,
        }));
        const result = validateCaptureResult(rawResult);
        await adopt(result.outbox);
        checkpoint(signal);
        const nextProcessed = processedConversations + result.counts.processedConversations;
        const nextCaptured = capturedMessages + result.counts.capturedMessages;
        if (!isCount(nextProcessed) || !isCount(nextCaptured)) invalidDependency();
        processedConversations = nextProcessed;
        capturedMessages = nextCaptured;
      };

      await deliverCurrent();
      if (captureNew) await runCapturePhase({ recoverPending: true, discoverNew: false });
      await normalizePendingTimestamps();
      if (captureNew) await runCapturePhase({ recoverPending: false, discoverNew: true });
      await normalizePendingTimestamps();
      await deliverCurrent();

      checkpoint(signal);
      return {
        processedConversations,
        capturedMessages,
        ...deliveryCounts,
        pendingRecovery: pendingCount(outbox, 'capture_pending'),
        pendingTimestamps: pendingCount(outbox, 'timestamp_pending'),
      };
    },
  });
}
