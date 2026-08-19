import { classifyBlocker, ScanInvariantError } from './linkedin-state.js';
import {
  MessageDataError,
  normalizeLeadName,
  normalizeVisibleText,
  validateConversationUrl,
} from './messages.js';

const ROW_SELECTOR = [
  '[data-reporter-row-id]',
  'li.msg-conversation-listitem',
  '[data-view-name="message-list-item"]',
].join(',');

const LIST_SELECTOR = [
  '[data-reporter-conversation-list]',
  '.msg-conversations-container__conversations-list',
  '[role="list"][aria-label*="conversation" i]',
].join(',');

const THREAD_SELECTOR = [
  '.msg-thread',
  '.msg-s-message-list',
  '[data-view-name="message-thread"]',
  '[data-reporter-detail-pane]',
].join(',');

const MESSAGE_SELECTOR = [
  '[data-reporter-message]',
  '.msg-s-event-listitem',
  '.msg-s-message-list__event',
].join(',');

const UNREAD_DIVIDER_SELECTOR = [
  '[data-reporter-unread-divider]',
  '.msg-s-message-list__unread-divider',
  '.msg-s-message-list__unread-message-divider',
].join(',');

const ROW_ID_ATTRIBUTES = [
  'data-reporter-row-id',
  'data-conversation-id',
  'data-entity-urn',
  'data-control-id',
  'id',
];

const DESTINATION_ATTRIBUTES = [
  'data-reporter-conversation-url',
  'data-conversation-url',
  'data-href',
];

const ACTIVE_ROW_SELECTOR = [
  '.active',
  '.msg-conversation-listitem--active',
  '.msg-conversation-card__convo-item-container--active',
  '[aria-current="true"]',
  '[aria-selected="true"]',
].join(',');

const DEFAULT_UNREAD_URL = 'https://www.linkedin.com/messaging/?filter=unread';

function classifyExactTimestamp(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(normalized);
  if (isoMatch) {
    const [, year, month, day, hour, minute, second] = isoMatch;
    const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    const timestamp = new Date(normalized);
    if (calendar.getUTCFullYear() !== Number(year)
      || calendar.getUTCMonth() + 1 !== Number(month)
      || calendar.getUTCDate() !== Number(day)
      || Number(hour) > 23
      || Number(minute) > 59
      || Number(second) > 59
      || Number.isNaN(timestamp.getTime())) {
      return { kind: 'invalid' };
    }
    return { kind: 'exact', sentAt: timestamp.toISOString() };
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(normalized)) return { kind: 'invalid' };

  const englishMatch = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(normalized);
  if (englishMatch) {
    const monthNames = [
      'january', 'february', 'march', 'april', 'may', 'june',
      'july', 'august', 'september', 'october', 'november', 'december',
    ];
    const [, monthName, dayText, yearText, hourText, minuteText, meridiem] = englishMatch;
    const year = Number(yearText);
    const month = monthNames.indexOf(monthName.toLowerCase());
    const day = Number(dayText);
    const twelveHour = Number(hourText);
    const minute = Number(minuteText);
    if (twelveHour < 1 || twelveHour > 12 || minute > 59) return { kind: 'invalid' };
    const hour = (twelveHour % 12) + (meridiem.toUpperCase() === 'PM' ? 12 : 0);
    const timestamp = new Date(year, month, day, hour, minute, 0, 0);
    if (timestamp.getFullYear() !== year
      || timestamp.getMonth() !== month
      || timestamp.getDate() !== day
      || timestamp.getHours() !== hour
      || timestamp.getMinutes() !== minute) {
      return { kind: 'invalid' };
    }
    return { kind: 'exact', sentAt: timestamp.toISOString() };
  }
  if (/^(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(normalized)
    && /\b\d{4}\b/.test(normalized)) {
    return { kind: 'invalid' };
  }
  return { kind: 'relative' };
}

export class LinkedInBlockerError extends Error {
  constructor(type) {
    super(`LinkedIn ${type} was not cleared within the allowed time. No report was sent.`);
    this.name = 'LinkedInBlockerError';
    this.type = type;
  }
}

const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function throwIfAborted(signal) {
  signal?.throwIfAborted();
}

async function checkedAwait(signal, operation) {
  throwIfAborted(signal);
  try {
    const result = await operation();
    throwIfAborted(signal);
    return result;
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  }
}

export function isTransientNavigationError(error) {
  const message = String(error?.message || '');
  return /execution context was destroyed(?:, most likely because of a navigation)?/i.test(message)
    || /cannot find context with specified id/i.test(message);
}

export async function waitForManualRecovery({
  readState,
  timeoutMs,
  pollIntervalMs = 2_000,
  now = Date.now,
  sleep = defaultSleep,
  onBlocker = () => {},
  onBlockerCleared = async () => {},
  isReady = (state) => state.inboxReady === true,
  readinessType = 'inbox readiness',
  signal,
}) {
  const deadline = now() + timeoutMs;
  let lastType = null;
  let recovered = false;
  let consecutiveReadyStates = 0;
  let blockerNeedsReentry = false;

  while (true) {
    throwIfAborted(signal);
    let state;
    try {
      state = await checkedAwait(signal, readState);
    } catch (error) {
      if (!isTransientNavigationError(error)) throw error;
      consecutiveReadyStates = 0;
      if (now() >= deadline) throw new LinkedInBlockerError(lastType || 'navigation');
      await checkedAwait(
        signal,
        () => sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now()))),
      );
      continue;
    }

    const type = classifyBlocker(state);
    if (now() >= deadline) {
      throw new LinkedInBlockerError(type || lastType || readinessType);
    }
    if (type) {
      recovered = true;
      consecutiveReadyStates = 0;
      blockerNeedsReentry = true;
      if (type !== lastType) {
        onBlocker({ type });
        throwIfAborted(signal);
        lastType = type;
      }
    } else if (blockerNeedsReentry) {
      consecutiveReadyStates = 0;
      blockerNeedsReentry = false;
      await checkedAwait(
        signal,
        () => onBlockerCleared({ remainingMs: Math.max(1, deadline - now()) }),
      );
    } else if (isReady(state)) {
      consecutiveReadyStates += 1;
      if (consecutiveReadyStates >= 2) return { recovered };
    } else {
      consecutiveReadyStates = 0;
    }

    if (now() >= deadline) throw new LinkedInBlockerError(lastType || readinessType);
    await checkedAwait(
      signal,
      () => sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now()))),
    );
  }
}

export class PlaywrightLinkedInAdapter {
  constructor(page, {
    onBlocker = () => {},
    authTimeoutMs = 900_000,
    recoveryOptions = {},
    signal,
  } = {}) {
    this.page = page;
    this.onBlocker = onBlocker;
    this.authTimeoutMs = authTimeoutMs;
    this.recoveryOptions = recoveryOptions;
    this.signal = signal;
    this.unreadUrl = null;
  }

  checkpoint() {
    throwIfAborted(this.signal);
  }

  async pageOperation(operation) {
    return checkedAwait(this.signal, operation);
  }

  async gotoUnread(url, { timeoutMs } = {}) {
    this.unreadUrl = url;
    const options = { waitUntil: 'domcontentloaded' };
    if (timeoutMs !== undefined) options.timeout = Math.max(1, timeoutMs);
    await this.pageOperation(() => this.page.goto(url, options));
  }

  async waitForUnblocked(timeoutMs, recoveryOptions = {}) {
    return waitForManualRecovery({
      ...recoveryOptions,
      timeoutMs,
      signal: this.signal,
      onBlocker: this.onBlocker,
      onBlockerCleared: async ({ remainingMs }) => {
        if (!this.unreadUrl) throw new ScanInvariantError('unread-url-not-initialized');
        await this.gotoUnread(this.unreadUrl, { timeoutMs: remainingMs });
      },
      readState: async () => this.pageOperation(() => this.page.evaluate(({ listSelector }) => {
        const isVisible = (element) => {
          if (!element) return false;
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none'
            && style.visibility !== 'hidden'
            && rect.width > 0
            && rect.height > 0;
        };
        const unreadButtons = [...document.querySelectorAll('button')].filter((button) => (
          /^\s*unread(?:\s|$)/i.test(button.textContent || '') && isVisible(button)
        ));
        const visibleLists = [...document.querySelectorAll(listSelector)].filter(isVisible);
        const hasVisibleMatch = (selector) => (
          [...document.querySelectorAll(selector)].some(isVisible)
        );
        let bodyText = '';
        if (hasVisibleMatch([
          'iframe[src*="captcha" i]',
          '[id*="captcha" i]',
          '[data-test*="captcha" i]',
        ].join(','))) {
          bodyText = 'captcha';
        } else if (hasVisibleMatch([
          'form[action*="checkpoint" i]',
          '[data-test*="challenge" i]',
          'input[name*="verification" i]',
        ].join(','))) {
          bodyText = 'security verification';
        }

        return {
          url: window.location.href,
          title: document.title,
          bodyText,
          inboxReady: unreadButtons.length === 1
            && unreadButtons[0].getAttribute('aria-pressed') === 'true'
            && visibleLists.length === 1,
        };
      }, { listSelector: LIST_SELECTOR })),
    });
  }

  async inspectState() {
    return this.pageOperation(() => this.page.evaluate(({ rowSelector, listSelector }) => {
      const isVisible = (element) => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const unreadButtons = [...document.querySelectorAll('button')].filter((button) => (
        /^\s*unread(?:\s|$)/i.test(button.textContent || '') && isVisible(button)
      ));
      const visibleLists = [...document.querySelectorAll(listSelector)].filter(isVisible);
      const visibleList = visibleLists.length === 1 ? visibleLists[0] : null;
      const rows = visibleList ? [...visibleList.querySelectorAll(rowSelector)] : [];
      const activeSelector = [
        '.active',
        '.msg-conversation-listitem--active',
        '.msg-conversation-card__convo-item-container--active',
        '[aria-current="true"]',
        '[aria-selected="true"]',
      ].join(',');
      const activeRowCount = rows.filter((row) => (
        row.matches(activeSelector) || row.querySelector(activeSelector)
      )).length;
      const detailPaneVisible = [...document.querySelectorAll([
        '.msg-thread',
        '.msg-s-message-list',
        '[data-view-name="message-thread"]',
        '[data-reporter-detail-pane]',
      ].join(','))].some(isVisible);

      return {
        unreadFilterPressed: unreadButtons.length === 1
          && unreadButtons[0].getAttribute('aria-pressed') === 'true',
        conversationListPresent: visibleLists.length === 1,
        conversationListCount: visibleLists.length,
        activeRowCount,
        detailPaneVisible,
      };
    }, { rowSelector: ROW_SELECTOR, listSelector: LIST_SELECTOR }));
  }

  async readRows({ limit = 51, excludeIds = [] } = {}) {
    const visibleLists = this.page.locator(LIST_SELECTOR).filter({ visible: true });
    if (await this.pageOperation(() => visibleLists.count()) !== 1) {
      throw new ScanInvariantError('conversation-list-not-uniquely-visible');
    }
    const rows = await this.pageOperation(() => (
      visibleLists.first().locator(ROW_SELECTOR).evaluateAll((elements, options) => {
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width > 0
          && rect.height > 0;
      };
      const excluded = new Set(options.excludeIds);
      const results = [];
      let qualifyingCount = 0;
      for (const row of elements) {
        if (!isVisible(row)) continue;
        const nameElement = row.querySelector([
          '[data-reporter-name]',
          '.msg-conversation-listitem__participant-names',
          '.msg-conversation-card__participant-names',
          'h3',
        ].join(','));
        const name = (nameElement?.textContent || '').replace(/\s+/g, ' ').trim();
        const explicitIdentity = [
          'data-reporter-row-id',
          'data-conversation-id',
          'data-entity-urn',
          'data-control-id',
          'id',
        ].map((attribute) => row.getAttribute(attribute)).find(Boolean);
        const ariaUnread = [...row.querySelectorAll('[aria-label]')].some((element) => (
          /^(?:unread message|\d+ unread messages?)$/i.test(
            (element.getAttribute('aria-label') || '').trim(),
          )
        ));
        const unread = row.classList.contains('msg-conversation-listitem--unread')
          || Boolean(row.querySelector('.msg-conversation-card__convo-item-container--unread'))
          || ariaUnread;
        const labels = [...row.querySelectorAll('[data-reporter-label], [aria-label], span, div')]
          .map((element) => element.getAttribute('data-reporter-label')
            || element.getAttribute('aria-label')
            || element.textContent)
          .map((value) => (value || '').replace(/\s+/g, ' ').trim())
          .filter((value) => /^(?:sponsored|automated|automated conversation)$/i.test(value));
        const result = {
          id: explicitIdentity || '',
          name,
          unread,
          labels,
        };
        if (result.id && excluded.has(result.id)) continue;
        results.push(result);
        const excludedLabel = labels.some((label) => (
          /^(?:sponsored|automated|automated conversation)$/i.test(label)
        ));
        if (unread && result.id && name && !excludedLabel) qualifyingCount += 1;
        if (qualifyingCount >= options.limit) break;
      }
      return results;
      }, { limit, excludeIds })
    ));
    if (rows.some((row) => row.unread && row.name && !row.id)) {
      throw new ScanInvariantError('conversation-row-identity-missing');
    }
    return rows;
  }

  async readUnreadCandidates({ limit = 50, excludeRowIds = [] } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new ScanInvariantError('candidate-limit-invalid');
    }
    try {
      const visibleLists = this.page.locator(LIST_SELECTOR).filter({ visible: true });
      if (await this.pageOperation(() => visibleLists.count()) !== 1) {
        throw new ScanInvariantError('conversation-list-not-uniquely-visible');
      }

      const rows = await this.pageOperation(() => (
        visibleLists.first().locator(ROW_SELECTOR).evaluateAll((elements, options) => {
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width > 0
          && rect.height > 0;
      };
      const normalized = (value) => (value || '').replace(/\s+/g, ' ').trim();
      return elements.filter(isVisible).map((row) => {
        const rowId = [
          'data-reporter-row-id',
          'data-conversation-id',
          'data-entity-urn',
          'data-control-id',
          'id',
        ].map((attribute) => row.getAttribute(attribute)).find(Boolean) || '';
        const nameElement = row.querySelector([
          '[data-reporter-name]',
          '.msg-conversation-listitem__participant-names',
          '.msg-conversation-card__participant-names',
          'h3',
        ].join(','));
        const ariaElements = [row, ...row.querySelectorAll('[aria-label]')]
          .filter((element) => element.hasAttribute('aria-label'));
        const ariaLabels = ariaElements
          .map((element) => normalized(element.getAttribute('aria-label')));
        const unread = row.classList.contains('msg-conversation-listitem--unread')
          || Boolean(row.querySelector('.msg-conversation-card__convo-item-container--unread'))
          || ariaLabels.some((label) => /^(?:unread message|\d+ unread messages?)$/i.test(label));
        const previewSelector = [
          '[data-preview]',
          '.msg-conversation-card__message-snippet',
          '.msg-conversation-listitem__message-snippet',
        ].join(',');
        const labelElements = [row, ...row.querySelectorAll([
          '[data-reporter-label]',
          '[aria-label]',
          'span',
          'div',
        ].join(','))].filter((element) => (
          isVisible(element)
          && !element.closest(previewSelector)
          && (element.hasAttribute('data-reporter-label')
            || element.hasAttribute('aria-label')
            || element.matches('span, div'))
        ));
        const explicitLabels = labelElements.map((element) => {
          if (element.hasAttribute('data-reporter-label')) {
            return normalized(element.getAttribute('data-reporter-label') || element.textContent);
          }
          if (element.hasAttribute('aria-label')) {
            return normalized(element.getAttribute('aria-label'));
          }
          return normalized(element.textContent);
        });
        const excluded = explicitLabels.some((label) => (
          /^(?:group|group chat|group conversation|sponsored|automated|automated conversation)$/i.test(label)
        ));
        const countLabels = ariaLabels
          .map((label) => /^(\d+) unread messages?$/i.exec(label))
          .filter(Boolean);
        const destinationAttributes = options.destinationAttributes;
        const destinationElements = [row, ...row.querySelectorAll([
          '[data-reporter-conversation-url]',
          '[data-conversation-url]',
          '[data-href]',
        ].join(','))].filter((element) => !element.closest(previewSelector));
        const destinations = [
          ...[...(row.matches('a[href]') ? [row] : []), ...row.querySelectorAll('a[href]')]
            .filter((anchor) => !anchor.closest(previewSelector))
            .map((anchor) => anchor.getAttribute('href')),
          ...destinationElements.flatMap((element) => destinationAttributes.map(
            (attribute) => element.getAttribute(attribute),
          )),
        ].filter((href) => /\/messaging\/thread\//.test(href || ''));
        const anchors = [...new Set(destinations)];
        return {
          rowId,
          leadName: normalized(nameElement?.textContent),
          unread,
          excluded,
          countLabels: countLabels.map((match) => match[1]),
          anchors,
        };
      });
    }, { destinationAttributes: DESTINATION_ATTRIBUTES })
      ));

      const excluded = new Set(excludeRowIds);
      const candidates = [];
      const seenRowIds = new Set();
      for (const row of rows) {
        if (!row.unread || row.excluded || excluded.has(row.rowId)) continue;
        if (!row.rowId) throw new ScanInvariantError('conversation-row-identity-missing');
        if (seenRowIds.has(row.rowId)) throw new ScanInvariantError('conversation-row-identity-ambiguous');
        seenRowIds.add(row.rowId);
        const conversationUrls = [...new Set(row.anchors.map(validateConversationUrl))];
        if (row.countLabels.length > 1 || conversationUrls.length > 1) {
          throw new ScanInvariantError('conversation-row-metadata-ambiguous');
        }
        const unreadCount = row.countLabels.length ? Number(row.countLabels[0]) : null;
        if (unreadCount !== null && (!Number.isSafeInteger(unreadCount) || unreadCount <= 0)) {
          throw new ScanInvariantError('conversation-unread-count-invalid');
        }
        candidates.push({
          rowId: row.rowId,
          leadName: normalizeLeadName(row.leadName),
          unreadCount,
          conversationUrl: conversationUrls[0] || null,
        });
        if (candidates.length >= limit) break;
      }
      return candidates;
    } catch (error) {
      this.checkpoint();
      if (error instanceof ScanInvariantError || error instanceof MessageDataError) throw error;
      throw new ScanInvariantError('candidate-read-failed');
    }
  }

  async revalidateUnreadCandidate(candidate) {
    try {
      if (typeof candidate?.rowId !== 'string' || !candidate.rowId.trim()) {
        throw new ScanInvariantError('conversation-row-identity-missing');
      }
      const visibleLists = this.page.locator(LIST_SELECTOR).filter({ visible: true });
      if (await this.pageOperation(() => visibleLists.count()) !== 1) {
        throw new ScanInvariantError('conversation-list-not-uniquely-visible');
      }
      const escapedRowId = await this.pageOperation(
        () => this.page.evaluate((value) => CSS.escape(value), candidate.rowId),
      );
      const rowSelector = [
        `[data-reporter-row-id="${escapedRowId}"]`,
        `[data-conversation-id="${escapedRowId}"]`,
        `[data-entity-urn="${escapedRowId}"]`,
        `[data-control-id="${escapedRowId}"]`,
        `[id="${escapedRowId}"]`,
      ].join(',');
      const rows = visibleLists.first().locator(rowSelector).filter({ visible: true });
      if (await this.pageOperation(() => rows.count()) !== 1) {
        throw new ScanInvariantError('conversation-row-not-uniquely-visible');
      }
      const refreshed = await this.pageOperation(() => rows.first().evaluate((row, options) => {
        const isVisible = (element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none'
            && style.visibility !== 'hidden'
            && rect.width > 0
            && rect.height > 0;
        };
        const normalized = (value) => (value || '').replace(/\s+/g, ' ').trim();
        const nameElement = row.querySelector([
          '[data-reporter-name]',
          '.msg-conversation-listitem__participant-names',
          '.msg-conversation-card__participant-names',
          'h3',
        ].join(','));
        const ariaLabels = [row, ...row.querySelectorAll('[aria-label]')]
          .filter((element) => element.hasAttribute('aria-label'))
          .map((element) => normalized(element.getAttribute('aria-label')));
        const unread = row.classList.contains('msg-conversation-listitem--unread')
          || Boolean(row.querySelector('.msg-conversation-card__convo-item-container--unread'))
          || ariaLabels.some((label) => /^(?:unread message|\d+ unread messages?)$/i.test(label));
        const previewSelector = [
          '[data-preview]',
          '.msg-conversation-card__message-snippet',
          '.msg-conversation-listitem__message-snippet',
        ].join(',');
        const labels = [row, ...row.querySelectorAll([
          '[data-reporter-label]', '[aria-label]', 'span', 'div',
        ].join(','))].filter((element) => (
          isVisible(element)
          && !element.closest(previewSelector)
          && (element.hasAttribute('data-reporter-label')
            || element.hasAttribute('aria-label')
            || element.matches('span, div'))
        )).map((element) => normalized(
          element.getAttribute('data-reporter-label')
            || element.getAttribute('aria-label')
            || element.textContent,
        ));
        const excluded = labels.some((label) => (
          /^(?:group|group chat|group conversation|sponsored|automated|automated conversation)$/i.test(label)
        ));
        const countLabels = ariaLabels
          .map((label) => /^(\d+) unread messages?$/i.exec(label))
          .filter(Boolean)
          .map((match) => match[1]);
        const destinationAttributes = options.destinationAttributes;
        const destinationElements = [row, ...row.querySelectorAll([
          '[data-reporter-conversation-url]',
          '[data-conversation-url]',
          '[data-href]',
        ].join(','))].filter((element) => !element.closest(previewSelector));
        const destinations = [
          ...[...(row.matches('a[href]') ? [row] : []), ...row.querySelectorAll('a[href]')]
            .filter((anchor) => !anchor.closest(previewSelector))
            .map((anchor) => anchor.getAttribute('href')),
          ...destinationElements.flatMap((element) => destinationAttributes.map(
            (attribute) => element.getAttribute(attribute),
          )),
        ].filter((href) => /\/messaging\/thread\//.test(href || ''));
        const anchors = [...new Set(destinations)];
        return {
          leadName: normalized(nameElement?.textContent),
          unread,
          excluded,
          countLabels,
          anchors,
        };
      }, { destinationAttributes: DESTINATION_ATTRIBUTES }));
      if (!refreshed.unread) throw new ScanInvariantError('conversation-row-no-longer-unread');
      if (refreshed.excluded) throw new ScanInvariantError('conversation-row-no-longer-eligible');
      const conversationUrls = [...new Set(refreshed.anchors.map(validateConversationUrl))];
      if (refreshed.countLabels.length > 1 || conversationUrls.length > 1) {
        throw new ScanInvariantError('conversation-row-metadata-ambiguous');
      }
      const unreadCount = refreshed.countLabels.length ? Number(refreshed.countLabels[0]) : null;
      if (unreadCount !== null && (!Number.isSafeInteger(unreadCount) || unreadCount <= 0)) {
        throw new ScanInvariantError('conversation-unread-count-invalid');
      }
      const currentUrl = conversationUrls[0] || null;
      if (candidate.conversationUrl !== null && candidate.conversationUrl !== undefined) {
        const expectedUrl = validateConversationUrl(candidate.conversationUrl);
        if (currentUrl !== expectedUrl) {
          throw new ScanInvariantError('conversation-row-url-changed');
        }
      }
      return {
        rowId: candidate.rowId.trim(),
        leadName: normalizeLeadName(refreshed.leadName),
        unreadCount,
        conversationUrl: currentUrl,
      };
    } catch (error) {
      this.checkpoint();
      if (error instanceof ScanInvariantError || error instanceof MessageDataError) throw error;
      throw new ScanInvariantError('candidate-revalidation-failed');
    }
  }

  async exactAnchorlessRow(rowId, { requireUnread = true } = {}) {
    if (typeof rowId !== 'string' || !rowId.trim()) {
      throw new ScanInvariantError('conversation-row-identity-missing');
    }
    const visibleLists = this.page.locator(LIST_SELECTOR).filter({ visible: true });
    if (await this.pageOperation(() => visibleLists.count()) !== 1) {
      throw new ScanInvariantError('conversation-row-not-uniquely-visible');
    }
    const escapedRowId = await this.pageOperation(
      () => this.page.evaluate((value) => CSS.escape(value), rowId),
    );
    const rowSelector = ROW_ID_ATTRIBUTES.map(
      (attribute) => `[${attribute}="${escapedRowId}"]`,
    ).join(',');
    const rows = visibleLists.first().locator(rowSelector).filter({ visible: true });
    if (await this.pageOperation(() => rows.count()) !== 1) {
      throw new ScanInvariantError('conversation-row-not-uniquely-visible');
    }
    const row = rows.first();
    if (requireUnread) {
      const stillUnread = await this.pageOperation(() => row.evaluate((element) => {
        const ariaUnread = [...element.querySelectorAll('[aria-label]')].some((candidate) => (
          /^(?:unread message|\d+ unread messages?)$/i.test(
            (candidate.getAttribute('aria-label') || '').trim(),
          )
        ));
        return element.classList.contains('msg-conversation-listitem--unread')
          || Boolean(element.querySelector('.msg-conversation-card__convo-item-container--unread'))
          || ariaUnread;
      }));
      if (!stillUnread) throw new ScanInvariantError('conversation-row-no-longer-unread');
    }
    return row;
  }

  async clickExactAnchorlessRow(rowId) {
    const row = await this.exactAnchorlessRow(rowId);
    await this.pageOperation(() => row.click());
  }

  async assertOpenedAnchorlessRow(rowId) {
    const state = await this.pageOperation(() => this.page.evaluate((options) => {
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden'
          && rect.width > 0 && rect.height > 0;
      };
      const lists = [...document.querySelectorAll(options.listSelector)].filter(isVisible);
      if (lists.length !== 1) return { listCount: lists.length, activeRowIds: [] };
      const rows = [...lists[0].querySelectorAll(options.rowSelector)].filter(isVisible);
      const activeRows = rows.filter((row) => (
        row.matches(options.activeSelector) || row.querySelector(options.activeSelector)
      ));
      return {
        listCount: 1,
        activeRowIds: activeRows.map((row) => options.rowIdAttributes
          .map((attribute) => row.getAttribute(attribute)).find(Boolean) || ''),
      };
    }, {
      listSelector: LIST_SELECTOR,
      rowSelector: ROW_SELECTOR,
      activeSelector: ACTIVE_ROW_SELECTOR,
      rowIdAttributes: ROW_ID_ATTRIBUTES,
    }));
    if (state.listCount !== 1
      || state.activeRowIds.length !== 1
      || state.activeRowIds[0] !== rowId.trim()) {
      throw new ScanInvariantError('conversation-open-row-mismatch');
    }
  }

  async waitForAnchorlessThread(rowId) {
    this.unreadUrl ||= DEFAULT_UNREAD_URL;
    await waitForManualRecovery({
      ...this.recoveryOptions,
      timeoutMs: this.authTimeoutMs,
      signal: this.signal,
      onBlocker: this.onBlocker,
      readinessType: 'thread navigation',
      isReady: (state) => {
        try {
          validateConversationUrl(state.url);
          return true;
        } catch {
          return false;
        }
      },
      onBlockerCleared: async ({ remainingMs }) => {
        await this.gotoUnread(this.unreadUrl, { timeoutMs: remainingMs });
        await this.clickExactAnchorlessRow(rowId);
      },
      readState: async () => this.pageOperation(() => this.page.evaluate(() => {
        const isVisible = (element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden'
            && rect.width > 0 && rect.height > 0;
        };
        const hasVisibleMatch = (selector) => (
          [...document.querySelectorAll(selector)].some(isVisible)
        );
        let bodyText = '';
        if (hasVisibleMatch('iframe[src*="captcha" i],[id*="captcha" i],[data-test*="captcha" i]')) {
          bodyText = 'captcha';
        } else if (hasVisibleMatch('form[action*="checkpoint" i],form[action*="login" i],[data-test*="challenge" i],input[name*="verification" i],input[type="password"]')) {
          bodyText = 'security verification';
        }
        return { url: window.location.href, title: document.title, bodyText };
      })),
    });
    const openedUrl = validateConversationUrl(this.page.url());
    await this.assertOpenedAnchorlessRow(rowId);
    return openedUrl;
  }

  async openConversation({ rowId, conversationUrl }, { onOpened } = {}) {
    try {
      this.checkpoint();
      const hasConversationUrl = conversationUrl !== null && conversationUrl !== undefined;
      let canonicalUrl = hasConversationUrl ? validateConversationUrl(conversationUrl) : null;
      if (canonicalUrl) {
        await this.pageOperation(() => this.page.goto(canonicalUrl, { waitUntil: 'domcontentloaded' }));
      } else {
        await this.clickExactAnchorlessRow(rowId);
        canonicalUrl = await this.waitForAnchorlessThread(rowId);
      }

      if (onOpened !== undefined) {
        if (typeof onOpened !== 'function') {
          throw new ScanInvariantError('conversation-open-checkpoint-invalid');
        }
        const openedUrl = validateConversationUrl(this.page.url());
        if (canonicalUrl && openedUrl !== canonicalUrl) {
          throw new ScanInvariantError('conversation-url-mismatch');
        }
        try {
          await checkedAwait(this.signal, () => onOpened(openedUrl));
        } catch {
          throw new ScanInvariantError('conversation-open-checkpoint-failed');
        }
      }

      await waitForManualRecovery({
        ...this.recoveryOptions,
        timeoutMs: this.authTimeoutMs,
        signal: this.signal,
        onBlocker: this.onBlocker,
        readinessType: 'thread readiness',
        isReady: (state) => {
          if (state.threadCount > 1) {
            throw new ScanInvariantError('conversation-thread-not-uniquely-visible');
          }
          return state.threadCount === 1;
        },
        onBlockerCleared: async ({ remainingMs }) => {
          if (!canonicalUrl) {
            throw new ScanInvariantError('conversation-url-unavailable-for-recovery');
          }
          await this.pageOperation(() => this.page.goto(canonicalUrl, {
            waitUntil: 'domcontentloaded',
            timeout: remainingMs,
          }));
        },
        readState: async () => this.pageOperation(() => this.page.evaluate(({ threadSelector }) => {
          const isVisible = (element) => {
            if (!element) return false;
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none'
              && style.visibility !== 'hidden'
              && rect.width > 0
              && rect.height > 0;
          };
          const hasVisibleMatch = (selector) => (
            [...document.querySelectorAll(selector)].some(isVisible)
          );
          let bodyText = '';
          if (hasVisibleMatch([
            'iframe[src*="captcha" i]',
            '[id*="captcha" i]',
            '[data-test*="captcha" i]',
          ].join(','))) {
            bodyText = 'captcha';
          } else if (hasVisibleMatch([
            'form[action*="checkpoint" i]',
            '[data-test*="challenge" i]',
            'input[name*="verification" i]',
          ].join(','))) {
            bodyText = 'security verification';
          }
          const visibleThreadMatches = [...document.querySelectorAll(threadSelector)]
            .filter(isVisible);
          const threadRoots = visibleThreadMatches.filter((candidate) => (
            !visibleThreadMatches.some(
              (other) => other !== candidate && candidate.contains(other),
            )
          ));
          return {
            url: window.location.href,
            title: document.title,
            bodyText,
            threadCount: threadRoots.length,
          };
        }, { threadSelector: THREAD_SELECTOR })),
      });
      const finalUrl = validateConversationUrl(this.page.url());
      if (canonicalUrl && finalUrl !== canonicalUrl) {
        throw new ScanInvariantError('conversation-url-mismatch');
      }
      return finalUrl;
    } catch (error) {
      this.checkpoint();
      if (error instanceof ScanInvariantError
        || error instanceof LinkedInBlockerError
        || error instanceof MessageDataError) {
        throw error;
      }
      throw new ScanInvariantError('conversation-open-failed');
    }
  }

  async readThreadMessages() {
    try {
      this.checkpoint();
      const conversationUrl = validateConversationUrl(this.page.url());
      const extracted = await this.pageOperation(() => this.page.evaluate((selectors) => {
        const isVisible = (element) => {
          if (!element) return false;
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none'
            && style.visibility !== 'hidden'
            && rect.width > 0
            && rect.height > 0;
        };
        const normalizedLabel = (value) => (value || '').replace(/\s+/g, ' ').trim();
        const visibleThreadMatches = [...document.querySelectorAll(selectors.threadSelector)]
          .filter(isVisible);
        const threadRoots = visibleThreadMatches.filter((candidate) => !visibleThreadMatches.some(
          (other) => other !== candidate && candidate.contains(other),
        ));
        if (threadRoots.length !== 1) {
          return { violation: 'conversation-thread-not-uniquely-visible' };
        }
        const [thread] = threadRoots;
        const directionOf = (message) => {
          const declared = (message.getAttribute('data-reporter-direction') || '').trim().toLowerCase();
          const inbound = declared === 'inbound'
            || message.classList.contains('msg-s-event-listitem--other')
            || message.classList.contains('msg-s-message-list__event--from-other')
            || Boolean(message.querySelector([
              '[data-reporter-direction="inbound"]',
              '.msg-s-event-listitem--other',
              '.msg-s-message-list__event--from-other',
            ].join(',')));
          const outbound = declared === 'outbound'
            || message.classList.contains('msg-s-event-listitem--from-me')
            || message.classList.contains('msg-s-message-list__event--from-me')
            || Boolean(message.querySelector([
              '[data-reporter-direction="outbound"]',
              '.msg-s-event-listitem--from-me',
              '.msg-s-message-list__event--from-me',
            ].join(',')));
          return inbound === outbound ? null : (inbound ? 'inbound' : 'outbound');
        };

        const messages = [];
        let unreadBoundaryIndex = null;
        let unreadBoundaryCount = 0;
        const messageSelectorPriority = [
          '[data-reporter-message]',
          '.msg-s-message-list__event',
          '.msg-s-event-listitem',
        ];
        const messageElements = messageSelectorPriority
          .map((selector) => [...thread.querySelectorAll(selector)].filter(isVisible))
          .find((elements) => elements.length > 0) || [];
        if (messageElements.length === 0) return { violation: 'message-list-missing' };
        const dividerElements = [...thread.querySelectorAll(selectors.unreadDividerSelector)]
          .filter(isVisible);
        const ordered = [...messageElements, ...dividerElements].sort((left, right) => {
          if (left === right) return 0;
          return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
        });
        for (const element of ordered) {
          if (!isVisible(element)) continue;
          if (element.matches(selectors.unreadDividerSelector)) {
            unreadBoundaryCount += 1;
            if (unreadBoundaryIndex === null) unreadBoundaryIndex = messages.length;
            continue;
          }
          if (!element.matches(selectors.messageSelector)) continue;

          const direction = directionOf(element);
          if (!direction) return { violation: 'message-direction-ambiguous' };

          const textElements = [...element.querySelectorAll([
            '[data-reporter-content]',
            '.msg-s-event-listitem__body',
            '.msg-s-event-listitem__message-bubble p',
          ].join(','))].filter(isVisible);
          let contentType = 'text';
          let content = '';
          const syntheticElements = [...element.querySelectorAll('[data-reporter-content-type]')]
            .filter(isVisible);
          let nonText = null;
          if (syntheticElements.length === 1) {
            const synthetic = syntheticElements[0];
            nonText = {
              type: normalizedLabel(synthetic.getAttribute('data-reporter-content-type')).toLowerCase(),
              label: normalizedLabel(
                synthetic.getAttribute('aria-label')
                  || synthetic.getAttribute('title')
                  || synthetic.getAttribute('data-reporter-label'),
              ),
            };
          } else if (syntheticElements.length > 1) {
            return { violation: 'message-content-ambiguous' };
          } else {
            const canonicalVisibleElements = (selector) => {
              const matches = [...element.querySelectorAll(selector)].filter(isVisible);
              return matches.filter((candidate) => !matches.some(
                (other) => other !== candidate && candidate.contains(other),
              ));
            };
            const categories = [
              {
                type: 'shared_post',
                fallback: 'Shared post',
                elements: canonicalVisibleElements([
                  '[data-reporter-shared-post]',
                  '.msg-s-event-listitem__shared-post',
                  '.msg-s-event-listitem__feed-update',
                ].join(',')),
              },
              {
                type: 'audio',
                fallback: 'Voice message',
                elements: canonicalVisibleElements([
                  '[data-reporter-voice]',
                  '.msg-s-event-listitem__voice-message',
                  'audio',
                ].join(',')),
              },
              {
                type: 'file',
                fallback: 'File attachment',
                elements: canonicalVisibleElements([
                  '[data-reporter-attachment]',
                  '.msg-s-event-listitem__attachment',
                  '.msg-s-event-listitem__file-attachment',
                  'a[download]',
                  'a[href*="/attachment/"]',
                ].join(',')),
              },
              {
                type: 'image',
                fallback: 'Image attachment',
                elements: canonicalVisibleElements('img').filter((image) => !image.closest([
                  '[data-reporter-avatar]',
                  '.msg-s-event-listitem__profile-picture',
                  '.presence-entity__image',
                  '[class*="EntityPhoto"]',
                ].join(','))),
              },
            ];
            const category = categories.find(({ elements }) => elements.length > 0);
            if (category?.elements.length > 1) {
              return { violation: 'message-content-ambiguous' };
            }
            if (category) {
              const [contentElement] = category.elements;
              nonText = {
                type: category.type,
                label: normalizedLabel(
                  contentElement.getAttribute('aria-label')
                    || contentElement.getAttribute('alt')
                    || contentElement.getAttribute('title')
                    || contentElement.innerText
                    || contentElement.closest('figure')?.getAttribute('aria-label')
                    || category.fallback,
                ),
              };
            }
          }
          if (textElements.length === 1 && nonText === null) {
            content = textElements[0].innerText;
          } else if (textElements.length === 0 && nonText !== null) {
            contentType = nonText.type;
            content = nonText.label;
            if (!/^(?:image|video|audio|file|attachment|shared_post)$/.test(contentType)) {
              return { violation: 'message-content-type-invalid' };
            }
          } else if (textElements.length > 1 || (textElements.length === 1 && nonText !== null)) {
            return { violation: 'message-content-ambiguous' };
          } else {
            return { violation: 'message-content-missing' };
          }
          if (!content.trim()) return { violation: 'message-content-missing' };

          const timestampElements = [...element.querySelectorAll('time')].filter(isVisible);
          if (timestampElements.length > 1) return { violation: 'message-time-ambiguous' };
          const timestamp = timestampElements[0] || null;
          const datetime = timestamp?.getAttribute('datetime')?.trim() || null;
          const title = normalizedLabel(timestamp?.getAttribute('title'));
          const ariaLabel = normalizedLabel(timestamp?.getAttribute('aria-label'));
          const visibleTimestamp = normalizedLabel(timestamp?.innerText);
          const timestampIndex = timestamp
            ? [...document.querySelectorAll('time')].indexOf(timestamp)
            : null;
          const linkedinMessageId = [
            'data-reporter-message-id',
            'data-message-id',
            'data-event-urn',
            'data-entity-urn',
          ].map((attribute) => element.getAttribute(attribute)?.trim()).find(Boolean) || null;
          messages.push({
            linkedinMessageId,
            direction,
            contentType,
            content,
            datetime,
            timestampTitle: title,
            timestampAriaLabel: ariaLabel,
            visibleTimestamp,
            timestampIndex,
          });
        }
        if (unreadBoundaryCount > 1) return { violation: 'unread-boundary-ambiguous' };
        return { unreadBoundaryIndex, messages };
      }, {
        threadSelector: THREAD_SELECTOR,
        messageSelector: MESSAGE_SELECTOR,
        unreadDividerSelector: UNREAD_DIVIDER_SELECTOR,
      }));

      if (extracted.violation) throw new ScanInvariantError(extracted.violation);
      const messages = [];
      for (const message of extracted.messages) {
        let sentAt = null;
        let sentAtRaw = message.timestampTitle
          || message.timestampAriaLabel
          || message.visibleTimestamp;
        if (message.datetime !== null) {
          const classified = classifyExactTimestamp(message.datetime);
          if (classified.kind !== 'exact') throw new ScanInvariantError('message-time-invalid');
          sentAt = classified.sentAt;
          sentAtRaw = message.visibleTimestamp || message.datetime;
        } else {
          for (const candidate of [message.timestampTitle, message.timestampAriaLabel]) {
            if (!candidate) continue;
            const classified = await this.pageOperation(
              () => this.page.evaluate(classifyExactTimestamp, candidate),
            );
            if (classified.kind === 'invalid') {
              throw new ScanInvariantError('message-time-invalid');
            }
            if (classified.kind === 'exact') {
              sentAt = classified.sentAt;
              sentAtRaw = candidate;
              break;
            }
          }
        }

        if (sentAt === null && message.timestampIndex !== null) {
          const timestamp = this.page.locator('time').nth(message.timestampIndex);
          if (!await this.pageOperation(() => timestamp.isVisible())) {
            throw new ScanInvariantError('message-time-drift');
          }
          await this.pageOperation(() => timestamp.hover());
          const describedBy = (
            await this.pageOperation(() => timestamp.getAttribute('aria-describedby')) || ''
          ).trim();
          let tooltips;
          if (describedBy) {
            const tooltipSelector = await this.pageOperation(() => this.page.evaluate((value) => value
              .split(/\s+/)
              .filter(Boolean)
              .map((id) => `#${CSS.escape(id)}`)
              .join(','), describedBy));
            tooltips = this.page.locator(tooltipSelector).filter({ visible: true });
          } else {
            tooltips = this.page.locator([
              '[role="tooltip"]',
              '.artdeco-tooltip__content',
              '.msg-s-event-listitem__timestamp-tooltip',
            ].join(',')).filter({ visible: true });
          }
          const tooltipCount = await this.pageOperation(() => tooltips.count());
          if (tooltipCount > 1) throw new ScanInvariantError('message-time-tooltip-ambiguous');
          if (tooltipCount === 1) {
            const tooltipRaw = normalizeVisibleText(
              await this.pageOperation(() => tooltips.first().innerText()),
            );
            const classified = await this.pageOperation(
              () => this.page.evaluate(classifyExactTimestamp, tooltipRaw),
            );
            if (classified.kind === 'invalid') {
              throw new ScanInvariantError('message-time-invalid');
            }
            if (classified.kind === 'exact') {
              sentAt = classified.sentAt;
              sentAtRaw = tooltipRaw;
            }
          }
        }

        messages.push({
          linkedinMessageId: message.linkedinMessageId,
          direction: message.direction,
          contentType: message.contentType,
          content: normalizeVisibleText(message.content),
          sentAt,
          sentAtRaw,
        });
      }
      const finalConversationUrl = validateConversationUrl(this.page.url());
      if (finalConversationUrl !== conversationUrl) {
        throw new ScanInvariantError('conversation-url-mismatch');
      }
      return {
        conversationUrl: finalConversationUrl,
        unreadBoundaryIndex: extracted.unreadBoundaryIndex,
        messages,
      };
    } catch (error) {
      this.checkpoint();
      if (error instanceof ScanInvariantError || error instanceof MessageDataError) throw error;
      throw new ScanInvariantError('thread-message-read-failed');
    }
  }

  loadMoreLocator() {
    return this.page.getByRole('button', { name: /^Load more conversations$/i });
  }

  async listProgressSnapshot() {
    const snapshot = await this.pageOperation(() => this.page.evaluate(({ listSelector, rowSelector }) => {
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width > 0
          && rect.height > 0;
      };
      const lists = [...document.querySelectorAll(listSelector)].filter(isVisible);
      if (lists.length !== 1) return { listCount: lists.length };
      const list = lists[0];
      const listRect = list.getBoundingClientRect();
      const visibleRows = [...list.querySelectorAll(rowSelector)].filter((row) => {
        if (!isVisible(row)) return false;
        const rect = row.getBoundingClientRect();
        return rect.bottom > listRect.top && rect.top < listRect.bottom;
      });
      const rowSignature = visibleRows.map((row, index) => {
        const identity = [
          'data-reporter-row-id', 'data-conversation-id', 'data-entity-urn',
          'data-control-id', 'id',
        ].map((attribute) => row.getAttribute(attribute)).find(Boolean) || `anonymous-${index}`;
        const anchors = [...row.querySelectorAll('a[href]')]
          .map((anchor) => anchor.getAttribute('href') || '')
          .sort()
          .join(',');
        return `${identity}:${anchors}`;
      }).join('|');
      return {
        listCount: 1,
        scrollTop: list.scrollTop,
        scrollHeight: list.scrollHeight,
        viewportHeight: list.clientHeight,
        rowCount: list.querySelectorAll(rowSelector).length,
        rowSignature,
      };
    }, { listSelector: LIST_SELECTOR, rowSelector: ROW_SELECTOR }));
    if (snapshot.listCount !== 1) {
      throw new ScanInvariantError('conversation-list-not-uniquely-visible');
    }
    return {
      scrollTop: snapshot.scrollTop,
      scrollHeight: snapshot.scrollHeight,
      viewportHeight: snapshot.viewportHeight,
      rowCount: snapshot.rowCount,
      rowSignature: snapshot.rowSignature,
    };
  }

  listProgress(before, after) {
    return {
      changed: after.rowCount !== before.rowCount
        || after.scrollHeight !== before.scrollHeight
        || after.scrollTop !== before.scrollTop
        || after.rowSignature !== before.rowSignature,
      before,
      after,
    };
  }

  async waitForListProgress(before, {
    timeoutMs = 3_000,
    pollIntervalMs = 100,
  } = {}) {
    const deadline = Date.now() + timeoutMs;
    await this.waitForStability();
    let after = await this.listProgressSnapshot();
    let progress = this.listProgress(before, after);
    while (!progress.changed && Date.now() < deadline) {
      await this.pageOperation(
        () => this.page.waitForTimeout(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()))),
      );
      after = await this.listProgressSnapshot();
      progress = this.listProgress(before, after);
    }
    return progress;
  }

  async hasLoadMore() {
    const controls = this.loadMoreLocator();
    const count = await this.pageOperation(() => controls.count());
    if (count === 0) return false;
    if (count !== 1) throw new ScanInvariantError('load-more-control-ambiguous');
    const control = controls.first();
    if (!await this.pageOperation(() => control.isVisible())) return false;
    const nestedInConversation = await this.pageOperation(() => control.evaluate(
      (element, rowSelector) => Boolean(element.closest(rowSelector)),
      ROW_SELECTOR,
    ));
    if (nestedInConversation) {
      throw new ScanInvariantError('load-more-control-inside-conversation-row');
    }
    return true;
  }

  async loadMore() {
    if (!await this.hasLoadMore()) {
      throw new ScanInvariantError('load-more-control-not-safe');
    }
    const before = await this.listProgressSnapshot();
    await this.pageOperation(() => this.loadMoreLocator().first().click());
    return this.waitForListProgress(before);
  }

  async scrollList() {
    const before = await this.listProgressSnapshot();
    const scrollTargetCount = await this.pageOperation(() => this.page.evaluate(({ listSelector }) => {
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const lists = [...document.querySelectorAll(listSelector)].filter(isVisible);
      if (lists.length === 1) {
        const list = lists[0];
        const step = Math.max(1, Math.floor(list.clientHeight * 0.8));
        list.scrollTop = Math.min(list.scrollTop + step, list.scrollHeight - list.clientHeight);
      }
      return lists.length;
    }, { listSelector: LIST_SELECTOR }));
    if (scrollTargetCount !== 1) {
      throw new ScanInvariantError('conversation-list-not-uniquely-visible');
    }
    await this.waitForStability();
    const after = await this.listProgressSnapshot();
    return this.listProgress(before, after);
  }

  async waitForStability() {
    await this.pageOperation(() => this.page.waitForTimeout(1_000));
  }
}

export async function withPersistentBrowser({
  chromium,
  profilePath,
  onBlocker,
  authTimeoutMs,
  signal,
  task,
}) {
  throwIfAborted(signal);
  let context;
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      headless: false,
      viewport: null,
    });
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  }
  let closePromise;
  const closeContext = () => {
    closePromise ||= Promise.resolve().then(() => context.close());
    return closePromise;
  };
  const onAbort = () => { void closeContext().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  let result;
  let primaryError;
  try {
    throwIfAborted(signal);
    const page = context.pages()[0] || await context.newPage();
    throwIfAborted(signal);
    result = await task(new PlaywrightLinkedInAdapter(page, {
      onBlocker,
      authTimeoutMs,
      signal,
    }));
    throwIfAborted(signal);
  } catch (error) {
    primaryError = signal?.aborted ? signal.reason : error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      await closeContext();
    } catch {
      if (!primaryError) primaryError = new Error('Browser cleanup failed.');
    }
  }
  if (signal?.aborted) throw signal.reason;
  if (primaryError) throw primaryError;
  return result;
}
