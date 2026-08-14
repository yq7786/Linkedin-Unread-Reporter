import { classifyBlocker, ScanInvariantError } from './linkedin-state.js';

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

export class LinkedInBlockerError extends Error {
  constructor(type) {
    super(`LinkedIn ${type} was not cleared within the allowed time. No report was sent.`);
    this.name = 'LinkedInBlockerError';
    this.type = type;
  }
}

const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function waitForManualRecovery({
  readState,
  timeoutMs,
  pollIntervalMs = 2_000,
  now = Date.now,
  sleep = defaultSleep,
  onBlocker = () => {},
}) {
  const deadline = now() + timeoutMs;
  let lastType = null;
  let recovered = false;

  while (true) {
    const type = classifyBlocker(await readState());
    if (!type) return { recovered };
    recovered = true;
    if (type !== lastType) {
      onBlocker({ type });
      lastType = type;
    }
    if (now() >= deadline) throw new LinkedInBlockerError(type);
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
  }
}

export class PlaywrightLinkedInAdapter {
  constructor(page, { onBlocker = () => {} } = {}) {
    this.page = page;
    this.onBlocker = onBlocker;
  }

  async gotoUnread(url) {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  async waitForUnblocked(timeoutMs) {
    const result = await waitForManualRecovery({
      timeoutMs,
      onBlocker: this.onBlocker,
      readState: async () => ({
        url: this.page.url(),
        title: await this.page.title(),
        bodyText: await this.page.evaluate(() => {
          if (document.querySelector([
            'iframe[src*="captcha" i]',
            '[id*="captcha" i]',
            '[data-test*="captcha" i]',
          ].join(','))) return 'captcha';
          if (document.querySelector([
            'form[action*="checkpoint" i]',
            '[data-test*="challenge" i]',
            'input[name*="verification" i]',
          ].join(','))) return 'security verification';
          return '';
        }),
      }),
    });
    if (result.recovered) return result;
    await this.page.waitForLoadState('domcontentloaded');
    await this.page
      .getByRole('button', { name: /^Unread(?:\s|$)/i })
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });
    return result;
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
      const excluded = new Set(options.excludeIds);
      const results = [];
      let qualifyingCount = 0;
      for (const row of elements) {
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
      const list = lists.length === 1 ? lists[0] : null;
      if (!list) return null;
      return {
        rowCount: list.querySelectorAll(rowSelector).length,
        scrollHeight: list.scrollHeight,
        scrollTop: list.scrollTop,
      };
    }, { listSelector: LIST_SELECTOR, rowSelector: ROW_SELECTOR });
    if (!before) return false;

    await this.page.evaluate(({ listSelector }) => {
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const lists = [...document.querySelectorAll(listSelector)].filter(isVisible);
      const list = lists.length === 1 ? lists[0] : null;
      if (list) list.scrollTop = list.scrollHeight;
    }, { listSelector: LIST_SELECTOR });
    await this.page.waitForTimeout(750);

    const after = await this.page.evaluate(({ listSelector, rowSelector }) => {
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const lists = [...document.querySelectorAll(listSelector)].filter(isVisible);
      const list = lists.length === 1 ? lists[0] : null;
      if (!list) return null;
      return {
        rowCount: list.querySelectorAll(rowSelector).length,
        scrollHeight: list.scrollHeight,
        scrollTop: list.scrollTop,
      };
    }, { listSelector: LIST_SELECTOR, rowSelector: ROW_SELECTOR });
    return Boolean(after && (
      after.rowCount !== before.rowCount
      || after.scrollHeight !== before.scrollHeight
      || after.scrollTop !== before.scrollTop
    ));
  }

  async waitForStability() {
    await this.page.waitForTimeout(1_000);
  }
}

export async function withPersistentBrowser({
  chromium,
  profilePath,
  onBlocker,
  task,
}) {
  const context = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    viewport: null,
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    return await task(new PlaywrightLinkedInAdapter(page, { onBlocker }));
  } finally {
    await context.close();
  }
}
