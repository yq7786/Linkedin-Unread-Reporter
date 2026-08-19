import { classifyBlocker, ScanInvariantError } from './linkedin-state.js';
import { MessageDataError, normalizeLeadName, validateConversationUrl } from './messages.js';

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

export class LinkedInBlockerError extends Error {
  constructor(type) {
    super(`LinkedIn ${type} was not cleared within the allowed time. No report was sent.`);
    this.name = 'LinkedInBlockerError';
    this.type = type;
  }
}

const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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
}) {
  const deadline = now() + timeoutMs;
  let lastType = null;
  let recovered = false;
  let consecutiveReadyStates = 0;
  let blockerNeedsReentry = false;

  while (true) {
    let state;
    try {
      state = await readState();
    } catch (error) {
      if (!isTransientNavigationError(error)) throw error;
      consecutiveReadyStates = 0;
      if (now() >= deadline) throw new LinkedInBlockerError(lastType || 'navigation');
      await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
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
        lastType = type;
      }
    } else if (blockerNeedsReentry) {
      consecutiveReadyStates = 0;
      blockerNeedsReentry = false;
      await onBlockerCleared({ remainingMs: Math.max(1, deadline - now()) });
    } else if (isReady(state)) {
      consecutiveReadyStates += 1;
      if (consecutiveReadyStates >= 2) return { recovered };
    } else {
      consecutiveReadyStates = 0;
    }

    if (now() >= deadline) throw new LinkedInBlockerError(lastType || readinessType);
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
  }
}

export class PlaywrightLinkedInAdapter {
  constructor(page, {
    onBlocker = () => {},
    authTimeoutMs = 900_000,
    recoveryOptions = {},
  } = {}) {
    this.page = page;
    this.onBlocker = onBlocker;
    this.authTimeoutMs = authTimeoutMs;
    this.recoveryOptions = recoveryOptions;
    this.unreadUrl = null;
  }

  async gotoUnread(url, { timeoutMs } = {}) {
    this.unreadUrl = url;
    const options = { waitUntil: 'domcontentloaded' };
    if (timeoutMs !== undefined) options.timeout = Math.max(1, timeoutMs);
    await this.page.goto(url, options);
  }

  async waitForUnblocked(timeoutMs, recoveryOptions = {}) {
    return waitForManualRecovery({
      ...recoveryOptions,
      timeoutMs,
      onBlocker: this.onBlocker,
      onBlockerCleared: async ({ remainingMs }) => {
        if (!this.unreadUrl) throw new ScanInvariantError('unread-url-not-initialized');
        await this.gotoUnread(this.unreadUrl, { timeoutMs: remainingMs });
      },
      readState: async () => this.page.evaluate(({ listSelector }) => {
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
      }, { listSelector: LIST_SELECTOR }),
    });
  }

  async inspectState() {
    return this.page.evaluate(({ rowSelector, listSelector }) => {
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
    }, { rowSelector: ROW_SELECTOR, listSelector: LIST_SELECTOR });
  }

  async readRows({ limit = 51, excludeIds = [] } = {}) {
    const visibleLists = this.page.locator(LIST_SELECTOR).filter({ visible: true });
    if (await visibleLists.count() !== 1) {
      throw new ScanInvariantError('conversation-list-not-uniquely-visible');
    }
    const rows = await visibleLists.first().locator(ROW_SELECTOR).evaluateAll((elements, options) => {
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
    }, { limit, excludeIds });
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
      if (await visibleLists.count() !== 1) {
        throw new ScanInvariantError('conversation-list-not-uniquely-visible');
      }

      const rows = await visibleLists.first().locator(ROW_SELECTOR).evaluateAll((elements) => {
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
        const anchors = [...row.querySelectorAll('a[href]')]
          .filter(isVisible)
          .map((anchor) => anchor.getAttribute('href'))
          .filter((href) => /\/messaging\/thread\//.test(href || ''));
        return {
          rowId,
          leadName: normalized(nameElement?.textContent),
          unread,
          excluded,
          countLabels: countLabels.map((match) => match[1]),
          anchors,
        };
      });
      });

      const excluded = new Set(excludeRowIds);
      const candidates = [];
      const seenRowIds = new Set();
      for (const row of rows) {
        if (!row.unread || row.excluded || excluded.has(row.rowId)) continue;
        if (!row.rowId) throw new ScanInvariantError('conversation-row-identity-missing');
        if (seenRowIds.has(row.rowId)) throw new ScanInvariantError('conversation-row-identity-ambiguous');
        seenRowIds.add(row.rowId);
        if (row.countLabels.length > 1 || row.anchors.length > 1) {
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
          conversationUrl: row.anchors.length ? validateConversationUrl(row.anchors[0]) : null,
        });
        if (candidates.length >= limit) break;
      }
      return candidates;
    } catch (error) {
      if (error instanceof ScanInvariantError || error instanceof MessageDataError) throw error;
      throw new ScanInvariantError('candidate-read-failed');
    }
  }

  async openConversation({ rowId, conversationUrl }) {
    try {
      const hasConversationUrl = conversationUrl !== null && conversationUrl !== undefined;
      const canonicalUrl = hasConversationUrl ? validateConversationUrl(conversationUrl) : null;
      if (canonicalUrl) {
        await this.page.goto(canonicalUrl, { waitUntil: 'domcontentloaded' });
      } else {
        if (typeof rowId !== 'string' || !rowId.trim()) {
          throw new ScanInvariantError('conversation-row-identity-missing');
        }
        const visibleLists = this.page.locator(LIST_SELECTOR).filter({ visible: true });
        if (await visibleLists.count() !== 1) {
          throw new ScanInvariantError('conversation-list-not-uniquely-visible');
        }
        const escapedRowId = await this.page.evaluate((value) => CSS.escape(value), rowId);
        const rowSelector = [
          `[data-reporter-row-id="${escapedRowId}"]`,
          `[data-conversation-id="${escapedRowId}"]`,
          `[data-entity-urn="${escapedRowId}"]`,
          `[data-control-id="${escapedRowId}"]`,
          `[id="${escapedRowId}"]`,
        ].join(',');
        const rows = visibleLists.first().locator(rowSelector).filter({ visible: true });
        if (await rows.count() !== 1) {
          throw new ScanInvariantError('conversation-row-not-uniquely-visible');
        }
        const stillUnread = await rows.first().evaluate((row) => {
          const ariaUnread = [...row.querySelectorAll('[aria-label]')].some((element) => (
            /^(?:unread message|\d+ unread messages?)$/i.test(
              (element.getAttribute('aria-label') || '').trim(),
            )
          ));
          return row.classList.contains('msg-conversation-listitem--unread')
            || Boolean(row.querySelector('.msg-conversation-card__convo-item-container--unread'))
            || ariaUnread;
        });
        if (!stillUnread) throw new ScanInvariantError('conversation-row-no-longer-unread');
        await rows.first().click();
      }

      await waitForManualRecovery({
        ...this.recoveryOptions,
        timeoutMs: this.authTimeoutMs,
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
          await this.page.goto(canonicalUrl, {
            waitUntil: 'domcontentloaded',
            timeout: remainingMs,
          });
        },
        readState: async () => this.page.evaluate(({ threadSelector }) => {
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
          return {
            url: window.location.href,
            title: document.title,
            bodyText,
            threadCount: [...document.querySelectorAll(threadSelector)].filter(isVisible).length,
          };
        }, { threadSelector: THREAD_SELECTOR }),
      });
      const finalUrl = validateConversationUrl(this.page.url());
      if (canonicalUrl && finalUrl !== canonicalUrl) {
        throw new ScanInvariantError('conversation-url-mismatch');
      }
      return finalUrl;
    } catch (error) {
      if (error instanceof ScanInvariantError
        || error instanceof LinkedInBlockerError
        || error instanceof MessageDataError) {
        throw error;
      }
      throw new ScanInvariantError('conversation-open-failed');
    }
  }

  loadMoreLocator() {
    return this.page.getByRole('button', { name: /^Load more conversations$/i });
  }

  async hasLoadMore() {
    const controls = this.loadMoreLocator();
    const count = await controls.count();
    if (count === 0) return false;
    if (count !== 1) throw new ScanInvariantError('load-more-control-ambiguous');
    const control = controls.first();
    if (!await control.isVisible()) return false;
    const nestedInConversation = await control.evaluate(
      (element, rowSelector) => Boolean(element.closest(rowSelector)),
      ROW_SELECTOR,
    );
    if (nestedInConversation) {
      throw new ScanInvariantError('load-more-control-inside-conversation-row');
    }
    return true;
  }

  async loadMore() {
    if (!await this.hasLoadMore()) {
      throw new ScanInvariantError('load-more-control-not-safe');
    }
    await this.loadMoreLocator().first().click();
    await this.page.waitForTimeout(750);
    return true;
  }

  async scrollList() {
    const before = await this.page.evaluate(({ listSelector, rowSelector }) => {
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const lists = [...document.querySelectorAll(listSelector)].filter(isVisible);
      if (lists.length !== 1) return { listCount: lists.length };
      const list = lists[0];
      return {
        listCount: 1,
        rowCount: list.querySelectorAll(rowSelector).length,
        scrollHeight: list.scrollHeight,
        scrollTop: list.scrollTop,
      };
    }, { listSelector: LIST_SELECTOR, rowSelector: ROW_SELECTOR });
    if (before.listCount !== 1) {
      throw new ScanInvariantError('conversation-list-not-uniquely-visible');
    }

    const scrollTargetCount = await this.page.evaluate(({ listSelector }) => {
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const lists = [...document.querySelectorAll(listSelector)].filter(isVisible);
      if (lists.length === 1) lists[0].scrollTop = lists[0].scrollHeight;
      return lists.length;
    }, { listSelector: LIST_SELECTOR });
    if (scrollTargetCount !== 1) {
      throw new ScanInvariantError('conversation-list-not-uniquely-visible');
    }
    await this.page.waitForTimeout(750);

    const after = await this.page.evaluate(({ listSelector, rowSelector }) => {
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const lists = [...document.querySelectorAll(listSelector)].filter(isVisible);
      if (lists.length !== 1) return { listCount: lists.length };
      const list = lists[0];
      return {
        listCount: 1,
        rowCount: list.querySelectorAll(rowSelector).length,
        scrollHeight: list.scrollHeight,
        scrollTop: list.scrollTop,
      };
    }, { listSelector: LIST_SELECTOR, rowSelector: ROW_SELECTOR });
    if (after.listCount !== 1) {
      throw new ScanInvariantError('conversation-list-not-uniquely-visible');
    }
    return Boolean(
      after.rowCount !== before.rowCount
      || after.scrollHeight !== before.scrollHeight
      || after.scrollTop !== before.scrollTop
    );
  }

  async waitForStability() {
    await this.page.waitForTimeout(1_000);
  }
}

export async function withPersistentBrowser({
  chromium,
  profilePath,
  onBlocker,
  authTimeoutMs,
  task,
}) {
  const context = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    viewport: null,
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    return await task(new PlaywrightLinkedInAdapter(page, { onBlocker, authTimeoutMs }));
  } finally {
    await context.close();
  }
}
