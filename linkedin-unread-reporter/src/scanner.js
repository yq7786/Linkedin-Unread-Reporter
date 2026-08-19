import { randomUUID } from 'node:crypto';

import { LinkedInBlockerError } from './browser.js';
import { assertUnreadListInvariants, normalizeConversationRow, ScanInvariantError } from './linkedin-state.js';
import {
  createIdempotencyKey,
  MessageDataError,
  normalizeLeadName,
  normalizeIsoTimestamp,
  normalizeVisibleText,
  selectUnreadInboundMessages,
  validateConversationUrl,
} from './messages.js';
import { validateOutbox } from './outbox.js';

const MAX_CAPTURE_ATTEMPTS = 3;
const MAX_DISCOVERY_ITERATIONS = 500;
const REQUIRED_STABLE_DISCOVERY_PASSES = 3;
const RECOVERABLE_SCAN_CODES = new Set([
  'conversation-thread-not-uniquely-visible',
  'conversation-url-mismatch',
  'message-content-ambiguous',
  'message-content-missing',
  'message-content-type-invalid',
  'message-direction-ambiguous',
  'message-list-missing',
  'message-time-ambiguous',
  'message-time-drift',
  'message-time-invalid',
  'message-time-tooltip-ambiguous',
  'unread-boundary-ambiguous',
]);
const RECOVERABLE_MESSAGE_CODES = new Set([
  'conversation-url-invalid',
  'message-content-type-invalid',
  'message-direction-invalid',
  'message-duplicate',
  'message-id-invalid',
  'message-invalid',
  'messages-invalid',
  'sent-at-invalid',
  'unread-boundary-invalid',
  'unread-count-invalid',
  'unread-selection-empty',
  'visible-content-invalid',
]);

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

function isRecoverableCaptureError(error) {
  if (error instanceof LinkedInBlockerError) return false;
  if (error instanceof ScanInvariantError) return RECOVERABLE_SCAN_CODES.has(error.code);
  if (error instanceof MessageDataError) return RECOVERABLE_MESSAGE_CODES.has(error.code);
  return false;
}

function replaceEntry(outbox, entryId, replacements) {
  const index = outbox.entries.findIndex((entry) => entry.entryId === entryId);
  if (index < 0) throw new Error('Capture recovery marker is missing.');
  return {
    ...outbox,
    entries: [
      ...outbox.entries.slice(0, index),
      ...replacements,
      ...outbox.entries.slice(index + 1),
    ],
  };
}

function normalizeScanStartedAt(value) {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new Error('Capture start time is invalid.');
  }
  return value.toISOString();
}

async function advanceUnreadList(adapter, knownHasLoadMore) {
  const hasLoadMore = knownHasLoadMore ?? await adapter.hasLoadMore();
  if (hasLoadMore) {
    const progress = await adapter.loadMore();
    if (typeof progress === 'boolean') return progress;
    if (progress && typeof progress.changed === 'boolean') return progress.changed;
    throw new ScanInvariantError('conversation-list-progress-invalid');
  }
  const progress = await adapter.scrollList();
  if (typeof progress === 'boolean') return progress;
  if (progress && typeof progress.changed === 'boolean') return progress.changed;
  throw new ScanInvariantError('conversation-list-progress-invalid');
}

async function discoverUnreadCandidate({
  adapter,
  processedConversationUrls,
  processedAnchorlessRowIds,
  discoveryBudget,
  signal,
}) {
  let stablePasses = 0;
  const pageExcludedRowIds = new Set(processedAnchorlessRowIds);
  while (true) {
    if (discoveryBudget.remaining <= 0) throw new ScanIterationError();
    discoveryBudget.remaining -= 1;
    checkpoint(signal);
    assertUnreadListInvariants(await checkedAwait(signal, () => adapter.inspectState()));
    const candidates = await checkedAwait(signal, () => adapter.readUnreadCandidates({
      limit: 50,
      excludeRowIds: [...pageExcludedRowIds],
    }));
    let excludedProcessedCandidate = false;
    for (const candidate of candidates) {
      if (candidate.conversationUrl !== null && candidate.conversationUrl !== undefined) {
        const conversationUrl = validateConversationUrl(candidate.conversationUrl);
        if (!processedConversationUrls.has(conversationUrl)) return candidate;
        pageExcludedRowIds.add(candidate.rowId);
        excludedProcessedCandidate = true;
      } else if (!processedAnchorlessRowIds.has(candidate.rowId)) {
        return candidate;
      }
    }
    if (excludedProcessedCandidate) continue;

    assertUnreadListInvariants(await checkedAwait(signal, () => adapter.inspectState()));
    const changed = await checkedAwait(signal, () => advanceUnreadList(adapter));
    if (changed) {
      stablePasses = 0;
      pageExcludedRowIds.clear();
      for (const rowId of processedAnchorlessRowIds) pageExcludedRowIds.add(rowId);
      continue;
    }
    stablePasses += 1;
    if (stablePasses >= REQUIRED_STABLE_DISCOVERY_PASSES) return null;
  }
}

function makeCaptureMarker({ leadName, conversationUrl, expectedUnreadCount, firstFailureAt }) {
  const marker = {
    entryId: `capture:${randomUUID()}`,
    state: 'capture_pending',
    leadName: normalizeLeadName(leadName),
    conversationUrl: validateConversationUrl(conversationUrl),
    firstFailureAt,
    attemptCount: 1,
  };
  if (expectedUnreadCount !== null && expectedUnreadCount !== undefined) {
    marker.expectedUnreadCount = expectedUnreadCount;
  }
  return marker;
}

function refreshCaptureMarker(marker, candidate) {
  const conversationUrl = validateConversationUrl(candidate.conversationUrl);
  if (conversationUrl !== marker.conversationUrl) {
    throw new ScanInvariantError('conversation-url-mismatch');
  }
  const { expectedUnreadCount: _staleUnreadCount, ...base } = marker;
  const refreshed = {
    ...base,
    leadName: normalizeLeadName(candidate.leadName),
    conversationUrl,
  };
  if (candidate.unreadCount !== null && candidate.unreadCount !== undefined) {
    refreshed.expectedUnreadCount = candidate.unreadCount;
  }
  return refreshed;
}

function makeMessageEntries({ marker, snapshot, scanStartedAt, outbox }) {
  const conversationUrl = validateConversationUrl(snapshot.conversationUrl);
  if (conversationUrl !== marker.conversationUrl) {
    throw new ScanInvariantError('conversation-url-mismatch');
  }
  const selected = selectUnreadInboundMessages({
    messages: snapshot.messages,
    unreadBoundaryIndex: snapshot.unreadBoundaryIndex,
    expectedUnreadCount: marker.expectedUnreadCount,
  });
  if (selected.length === 0) throw new MessageDataError('unread-selection-empty');

  const selectedIds = new Set();
  const selectedKeys = new Set();
  const entries = selected.map((rawMessage) => {
    const linkedinMessageId = rawMessage.linkedinMessageId === null
      || rawMessage.linkedinMessageId === undefined
      ? null
      : rawMessage.linkedinMessageId;
    if (linkedinMessageId !== null
      && (typeof linkedinMessageId !== 'string' || !linkedinMessageId.trim())) {
      throw new MessageDataError('message-id-invalid');
    }
    const normalizedMessageId = linkedinMessageId?.trim() ?? null;
    if (normalizedMessageId !== null) {
      if (selectedIds.has(normalizedMessageId)) throw new MessageDataError('message-duplicate');
      selectedIds.add(normalizedMessageId);
    }
    if (typeof rawMessage.contentType !== 'string' || !rawMessage.contentType.trim()) {
      throw new MessageDataError('message-content-type-invalid');
    }
    const common = {
      entryId: `message:${randomUUID()}`,
      leadName: marker.leadName,
      conversationUrl,
      linkedinMessageId: normalizedMessageId,
      contentType: rawMessage.contentType.trim(),
      content: normalizeVisibleText(rawMessage.content),
      sentAtRaw: normalizeVisibleText(rawMessage.sentAtRaw),
    };
    if (rawMessage.sentAt === null || rawMessage.sentAt === undefined) {
      return {
        ...common,
        state: 'timestamp_pending',
        scanStartedAt,
      };
    }
    const sentAt = normalizeIsoTimestamp(rawMessage.sentAt);
    const idempotencyKey = createIdempotencyKey({
      linkedinMessageId: normalizedMessageId,
      leadName: marker.leadName,
      sentAt,
      conversationUrl,
    });
    if (selectedKeys.has(idempotencyKey)) throw new MessageDataError('message-duplicate');
    selectedKeys.add(idempotencyKey);
    return {
      ...common,
      state: 'ready',
      idempotencyKey,
      sentAt,
      sentAtAccuracy: 'exact',
    };
  });

  const existingMessageIds = new Set(outbox.entries
    .map(({ linkedinMessageId }) => linkedinMessageId)
    .filter((value) => value !== null && value !== undefined));
  const existingKeys = new Set(outbox.entries
    .map(({ idempotencyKey }) => idempotencyKey)
    .filter(Boolean));
  return entries.filter((entry) => (
    (entry.linkedinMessageId === null || !existingMessageIds.has(entry.linkedinMessageId))
    && (entry.state !== 'ready' || !existingKeys.has(entry.idempotencyKey))
  ));
}

export async function captureUnreadMessages({
  adapter,
  outbox,
  saveOutbox,
  unreadUrl,
  scanStartedAt,
  cap = 50,
  authTimeoutMs = 900_000,
  recoverPending = true,
  captureNew = true,
  signal,
}) {
  if (!Number.isInteger(cap) || cap < 1 || cap > 50) {
    throw new Error('Capture conversation cap must be an integer from 1 to 50.');
  }
  if (typeof recoverPending !== 'boolean' || typeof captureNew !== 'boolean') {
    throw new Error('Capture phase options are invalid.');
  }
  checkpoint(signal);
  let currentOutbox = validateOutbox(outbox);
  const scanStartedAtIso = normalizeScanStartedAt(scanStartedAt);
  let processedConversations = 0;
  let capturedMessages = 0;

  const persist = async (nextOutbox) => {
    checkpoint(signal);
    validateOutbox(nextOutbox);
    await checkedAwait(signal, () => saveOutbox(nextOutbox));
    checkpoint(signal);
    currentOutbox = nextOutbox;
  };

  const captureMarker = async (marker, {
    alreadyOpen = false,
    newMarker = false,
    initialCandidate = null,
  } = {}) => {
    let attemptsThisRun = 0;
    while (attemptsThisRun < MAX_CAPTURE_ATTEMPTS) {
      checkpoint(signal);
      attemptsThisRun += 1;
      let entries;
      try {
        if (!(alreadyOpen && attemptsThisRun === 1)) {
          const openTarget = attemptsThisRun === 1 && initialCandidate
            ? initialCandidate
            : { conversationUrl: marker.conversationUrl };
          await checkedAwait(signal, () => adapter.openConversation(openTarget));
        }
        const snapshot = await checkedAwait(signal, () => adapter.readThreadMessages());
        checkpoint(signal);
        entries = makeMessageEntries({
          marker,
          snapshot,
          scanStartedAt: scanStartedAtIso,
          outbox: currentOutbox,
        });
      } catch (error) {
        if (!isRecoverableCaptureError(error)) throw error;
        continue;
      }
      await checkedAwait(signal, () => persist(
        replaceEntry(currentOutbox, marker.entryId, entries),
      ));
      checkpoint(signal);
      capturedMessages += entries.length;
      return;
    }

    const failedAttempts = marker.attemptCount + (newMarker
      ? MAX_CAPTURE_ATTEMPTS - 1
      : MAX_CAPTURE_ATTEMPTS);
    const retainedMarker = { ...marker, attemptCount: failedAttempts };
    await checkedAwait(signal, () => persist(
      replaceEntry(currentOutbox, marker.entryId, [retainedMarker]),
    ));
  };

  const openValidatedDirectCandidate = async (initialMarker, initialCandidate) => {
    let marker = initialMarker;
    let candidate = initialCandidate;
    for (let validationAttempt = 0;
      validationAttempt < MAX_CAPTURE_ATTEMPTS;
      validationAttempt += 1) {
      assertUnreadListInvariants(await checkedAwait(signal, () => adapter.inspectState()));
      const refreshedCandidate = await checkedAwait(
        signal,
        () => adapter.revalidateUnreadCandidate(candidate),
      );
      const refreshedMarker = refreshCaptureMarker(marker, refreshedCandidate);
      const markerChanged = refreshedMarker.leadName !== marker.leadName
        || refreshedMarker.expectedUnreadCount !== marker.expectedUnreadCount;
      marker = refreshedMarker;
      candidate = refreshedCandidate;
      if (markerChanged) {
        await checkedAwait(signal, () => persist(
          replaceEntry(currentOutbox, marker.entryId, [marker]),
        ));
        continue;
      }
      await checkedAwait(signal, () => captureMarker(marker, {
        newMarker: true,
        initialCandidate: candidate,
      }));
      return marker;
    }
    throw new ScanIterationError();
  };

  const recoveryMarkers = currentOutbox.entries
    .filter(({ state }) => state === 'capture_pending')
    .map((entry) => ({ ...entry }));
  const recoveredConversationUrls = new Set(
    recoveryMarkers.map(({ conversationUrl }) => conversationUrl),
  );
  const processedConversationUrls = new Set(recoveredConversationUrls);
  if (recoverPending) {
    for (const marker of recoveryMarkers) {
      checkpoint(signal);
      await checkedAwait(signal, () => captureMarker(marker));
      checkpoint(signal);
      processedConversations += 1;
    }
  }

  const processedAnchorlessRowIds = new Set();
  const discoveryBudget = { remaining: MAX_DISCOVERY_ITERATIONS };
  let processedNewConversations = 0;
  let truncated = false;
  while (captureNew) {
    checkpoint(signal);
    await checkedAwait(signal, () => adapter.gotoUnread(unreadUrl));
    await checkedAwait(signal, () => adapter.waitForUnblocked(authTimeoutMs));
    const candidate = await discoverUnreadCandidate({
      adapter,
      processedConversationUrls,
      processedAnchorlessRowIds,
      discoveryBudget,
      signal,
    });
    if (candidate === null) break;
    checkpoint(signal);
    let candidateConversationUrl = null;
    if (candidate.conversationUrl !== null && candidate.conversationUrl !== undefined) {
      candidateConversationUrl = validateConversationUrl(candidate.conversationUrl);
      if (processedConversationUrls.has(candidateConversationUrl)) continue;
    }
    if (processedNewConversations >= cap) {
      truncated = true;
      break;
    }
    assertUnreadListInvariants(await checkedAwait(signal, () => adapter.inspectState()));

    let marker;
    if (candidate.conversationUrl !== null && candidate.conversationUrl !== undefined) {
      marker = makeCaptureMarker({
        leadName: candidate.leadName,
        conversationUrl: candidate.conversationUrl,
        expectedUnreadCount: candidate.unreadCount,
        firstFailureAt: scanStartedAtIso,
      });
      await checkedAwait(signal, () => persist({
        ...currentOutbox,
        entries: [...currentOutbox.entries, marker],
      }));
      marker = await openValidatedDirectCandidate(marker, candidate);
    } else {
      assertUnreadListInvariants(await checkedAwait(signal, () => adapter.inspectState()));
      let refreshedCandidate = await checkedAwait(
        signal,
        () => adapter.revalidateUnreadCandidate(candidate),
      );
      if (refreshedCandidate.conversationUrl === null) {
        assertUnreadListInvariants(await checkedAwait(signal, () => adapter.inspectState()));
        refreshedCandidate = await checkedAwait(
          signal,
          () => adapter.revalidateUnreadCandidate(candidate),
        );
      }
      if (refreshedCandidate.conversationUrl !== null) {
        marker = makeCaptureMarker({
          leadName: refreshedCandidate.leadName,
          conversationUrl: refreshedCandidate.conversationUrl,
          expectedUnreadCount: refreshedCandidate.unreadCount,
          firstFailureAt: scanStartedAtIso,
        });
        await checkedAwait(signal, () => persist({
          ...currentOutbox,
          entries: [...currentOutbox.entries, marker],
        }));
        marker = await openValidatedDirectCandidate(marker, refreshedCandidate);
      } else {
        await checkedAwait(signal, () => adapter.openConversation(refreshedCandidate, {
          onOpened: async (conversationUrl) => {
            checkpoint(signal);
            marker = makeCaptureMarker({
              leadName: refreshedCandidate.leadName,
              conversationUrl,
              expectedUnreadCount: refreshedCandidate.unreadCount,
              firstFailureAt: scanStartedAtIso,
            });
            await checkedAwait(signal, () => persist({
              ...currentOutbox,
              entries: [...currentOutbox.entries, marker],
            }));
          },
        }));
        if (!marker) throw new Error('Opened conversation was not checkpointed.');
        await checkedAwait(signal, () => captureMarker(marker, {
          alreadyOpen: true,
          newMarker: true,
        }));
        processedAnchorlessRowIds.add(candidate.rowId);
      }
    }
    processedConversationUrls.add(marker.conversationUrl);
    checkpoint(signal);
    processedConversations += 1;
    processedNewConversations += 1;
  }

  return {
    outbox: currentOutbox,
    processedConversations,
    capturedMessages,
    pendingRecovery: currentOutbox.entries.filter(({ state }) => state === 'capture_pending').length,
    pendingTimestamps: currentOutbox.entries.filter(({ state }) => state === 'timestamp_pending').length,
    truncated,
  };
}

export class ScanIterationError extends Error {
  constructor() {
    super('LinkedIn unread-list scan did not stabilize safely. No report was sent.');
    this.name = 'ScanIterationError';
  }
}

export async function scanUnreadConversations({
  adapter,
  unreadUrl,
  cap = 50,
  authTimeoutMs = 900_000,
  maxIterations = 100,
  requiredStablePasses = 3,
}) {
  await adapter.gotoUnread(unreadUrl);
  await adapter.waitForUnblocked(authTimeoutMs);

  const conversations = new Map();
  let stablePasses = 0;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    assertUnreadListInvariants(await adapter.inspectState());

    const previousSize = conversations.size;
    const remainingCapacity = Math.max(0, cap - conversations.size);
    for (const rawRow of await adapter.readRows({
      limit: remainingCapacity + 1,
      excludeIds: [...conversations.keys()],
    })) {
      const conversation = normalizeConversationRow(rawRow);
      if (conversation && !conversations.has(conversation.id)) {
        conversations.set(conversation.id, conversation);
      }
    }
    if (conversations.size !== previousSize) stablePasses = 0;

    if (conversations.size > cap) {
      return {
        conversations: [...conversations.values()].slice(0, cap),
        truncated: true,
      };
    }

    const hasLoadMore = await adapter.hasLoadMore();
    if (conversations.size === cap && hasLoadMore) {
      return {
        conversations: [...conversations.values()],
        truncated: true,
      };
    }

    const changed = await advanceUnreadList(adapter, hasLoadMore);
    if (changed) {
      stablePasses = 0;
      continue;
    }

    stablePasses += 1;
    if (stablePasses >= requiredStablePasses) {
      return {
        conversations: [...conversations.values()],
        truncated: false,
      };
    }
  }

  throw new ScanIterationError();
}
