export class ScanInvariantError extends Error {
  constructor(code) {
    super(`LinkedIn unread-list safety invariant failed: ${code}. No report was sent.`);
    this.name = 'ScanInvariantError';
    this.code = code;
  }
}

export function assertUnreadListInvariants({
  unreadFilterPressed,
  conversationListPresent,
  conversationListCount,
  activeRowCount,
  detailPaneVisible,
}) {
  if (!unreadFilterPressed) throw new ScanInvariantError('unread-filter-not-active');
  if (!conversationListPresent || conversationListCount === 0) {
    throw new ScanInvariantError('conversation-list-missing');
  }
  if (conversationListCount !== 1) throw new ScanInvariantError('conversation-list-ambiguous');
  if (activeRowCount !== 0) throw new ScanInvariantError('conversation-row-active');
  if (detailPaneVisible) throw new ScanInvariantError('conversation-detail-visible');
}

function normalizeLabels(labels = []) {
  return labels.map((label) => String(label).trim().toLocaleLowerCase('en'));
}

export function normalizeConversationRow(row) {
  if (!row?.unread) return null;
  const id = String(row.id || '').trim();
  const name = String(row.name || '').replace(/\s+/g, ' ').trim();
  if (!id || !name) return null;

  const labels = normalizeLabels(row.labels);
  if (labels.some((label) => label === 'sponsored'
    || label === 'automated'
    || label === 'automated conversation')) {
    return null;
  }

  return { id, name };
}

export function classifyBlocker({ url = '', title = '', bodyText = '' }) {
  const normalizedUrl = String(url).toLocaleLowerCase('en');
  const visibleState = `${title}\n${bodyText}`.toLocaleLowerCase('en');

  if (normalizedUrl.includes('/checkpoint/') || normalizedUrl.includes('/challenge/')) {
    return 'checkpoint';
  }
  if (normalizedUrl.includes('/login')
    || normalizedUrl.includes('/authwall')
    || normalizedUrl.includes('/uas/login')) {
    return 'login';
  }
  if (/\bcaptcha\b/.test(visibleState) || visibleState.includes('verify you are human')) {
    return 'captcha';
  }
  if (visibleState.includes('security verification')
    || visibleState.includes('security check')
    || visibleState.includes('verify your identity')) {
    return 'challenge';
  }
  return null;
}
