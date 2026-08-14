import assert from 'node:assert/strict';
import test from 'node:test';

import { scanUnreadConversations } from '../src/scanner.js';
import { ScanInvariantError } from '../src/linkedin-state.js';

const unreadUrl = 'https://www.linkedin.com/messaging/?filter=unread';
const safeState = {
  unreadFilterPressed: true,
  conversationListPresent: true,
  activeRowCount: 0,
  detailPaneVisible: false,
};
const row = (id, name = `Person ${id}`, extra = {}) => ({ id, name, unread: true, labels: [], ...extra });

class FakeAdapter {
  constructor(snapshots, blockerResults = [{ recovered: false }]) {
    this.snapshots = snapshots;
    this.blockerResults = blockerResults;
    this.index = 0;
    this.visited = [];
    this.loadMoreCalls = 0;
    this.scrollCalls = 0;
  }

  async gotoUnread(url) { this.visited.push(url); }
  async waitForUnblocked() { return this.blockerResults.shift() || { recovered: false }; }
  async inspectState() { return this.snapshots[this.index].state || safeState; }
  async readRows() { return this.snapshots[this.index].rows; }
  async hasLoadMore() { return Boolean(this.snapshots[this.index].loadMore); }
  async loadMore() {
    this.loadMoreCalls += 1;
    if (this.index < this.snapshots.length - 1) this.index += 1;
    return true;
  }
  async scrollList() {
    this.scrollCalls += 1;
    if (this.index < this.snapshots.length - 1) {
      this.index += 1;
      return true;
    }
    return false;
  }
  async waitForStability() {}
}

test('scanner navigates directly and stops when the list is stable', async () => {
  const adapter = new FakeAdapter([{ rows: [row('1'), row('2')] }]);
  const result = await scanUnreadConversations({ adapter, unreadUrl, cap: 50, authTimeoutMs: 10 });

  assert.deepEqual(adapter.visited, [unreadUrl]);
  assert.deepEqual(result, {
    conversations: [{ id: '1', name: 'Person 1' }, { id: '2', name: 'Person 2' }],
    truncated: false,
  });
  assert.equal(adapter.scrollCalls, 3);
});

test('scanner does not accept a transient empty list as stable', async () => {
  let readCount = 0;
  const adapter = {
    gotoUnread: async () => {},
    waitForUnblocked: async () => ({ recovered: false }),
    inspectState: async () => safeState,
    readRows: async () => (readCount >= 1 ? [row('late')] : []),
    hasLoadMore: async () => false,
    scrollList: async () => false,
    waitForStability: async () => { readCount += 1; },
  };
  const result = await scanUnreadConversations({ adapter, unreadUrl, cap: 50, authTimeoutMs: 10 });
  assert.deepEqual(result.conversations, [{ id: 'late', name: 'Person late' }]);
});

test('scanner re-enters the direct unread URL after manual blocker recovery', async () => {
  const adapter = new FakeAdapter(
    [{ rows: [row('1')] }],
    [{ recovered: true }, { recovered: false }],
  );
  await scanUnreadConversations({ adapter, unreadUrl, cap: 50, authTimeoutMs: 10 });
  assert.deepEqual(adapter.visited, [unreadUrl, unreadUrl]);
});

test('scanner uses load more before scrolling', async () => {
  const adapter = new FakeAdapter([
    { rows: [row('1')], loadMore: true },
    { rows: [row('1'), row('2')] },
  ]);
  const result = await scanUnreadConversations({ adapter, unreadUrl, cap: 50, authTimeoutMs: 10 });
  assert.equal(adapter.loadMoreCalls, 1);
  assert.equal(result.conversations.length, 2);
});

test('scanner de-duplicates virtualized rows by row identity', async () => {
  const adapter = new FakeAdapter([
    { rows: [row('1', 'First')] },
    { rows: [row('1', 'First'), row('2', 'Second')] },
  ]);
  const result = await scanUnreadConversations({ adapter, unreadUrl, cap: 50, authTimeoutMs: 10 });
  assert.deepEqual(result.conversations.map(({ id }) => id), ['1', '2']);
});

test('scanner excludes ineligible rows and handles zero results', async () => {
  const adapter = new FakeAdapter([{ rows: [
    row('read', 'Read', { unread: false }),
    row('ad', 'Ad', { labels: ['Sponsored'] }),
  ] }]);
  const result = await scanUnreadConversations({ adapter, unreadUrl, cap: 50, authTimeoutMs: 10 });
  assert.deepEqual(result, { conversations: [], truncated: false });
});

test('scanner fails closed before extracting rows if an invariant is unsafe', async () => {
  const adapter = new FakeAdapter([{ state: { ...safeState, activeRowCount: 1 }, rows: [row('1')] }]);
  await assert.rejects(
    scanUnreadConversations({ adapter, unreadUrl, cap: 50, authTimeoutMs: 10 }),
    ScanInvariantError,
  );
});

test('scanner marks an early cap as truncated but exact stable cap as complete', async () => {
  const fifty = Array.from({ length: 50 }, (_, index) => row(String(index)));
  const stable = await scanUnreadConversations({
    adapter: new FakeAdapter([{ rows: fifty }]), unreadUrl, cap: 50, authTimeoutMs: 10,
  });
  assert.equal(stable.conversations.length, 50);
  assert.equal(stable.truncated, false);

  const overCap = await scanUnreadConversations({
    adapter: new FakeAdapter([{ rows: [...fifty, row('50')] }]), unreadUrl, cap: 50, authTimeoutMs: 10,
  });
  assert.equal(overCap.conversations.length, 50);
  assert.equal(overCap.truncated, true);
});

test('scanner stops at exactly 50 without activating a visible load-more control', async () => {
  const fifty = Array.from({ length: 50 }, (_, index) => row(String(index)));
  const adapter = new FakeAdapter([{ rows: fifty, loadMore: true }]);
  const result = await scanUnreadConversations({
    adapter, unreadUrl, cap: 50, authTimeoutMs: 10,
  });
  assert.equal(result.conversations.length, 50);
  assert.equal(result.truncated, true);
  assert.equal(adapter.loadMoreCalls, 0);
});
