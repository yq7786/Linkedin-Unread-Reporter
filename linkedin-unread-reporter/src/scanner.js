import { assertUnreadListInvariants, normalizeConversationRow } from './linkedin-state.js';

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
  for (let recoveryAttempt = 0; recoveryAttempt < 3; recoveryAttempt += 1) {
    const { recovered = false } = await adapter.waitForUnblocked(authTimeoutMs) || {};
    if (!recovered) break;
    await adapter.gotoUnread(unreadUrl);
  }

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

    if (hasLoadMore) {
      stablePasses = 0;
      await adapter.loadMore();
      continue;
    }

    const changed = await adapter.scrollList();
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
    await adapter.waitForStability?.();
  }

  throw new ScanIterationError();
}
