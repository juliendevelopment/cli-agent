const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-agent-test-'));
process.env.XDG_CONFIG_HOME = tmpHome;

const { parseRecentTabs, pushRecentTab, cellWidth } = require('../src/tmux');
const { SwitcherApp, findInitialSelection } = require('../src/switcher');
const { stripAnsi } = require('../src/ui');
const { STATUS_TYPES } = require('../src/monitor');

test.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

test('parseRecentTabs parses, deduplicates, and filters invalid pane ids', () => {
  assert.deepEqual(parseRecentTabs(''), []);
  assert.deepEqual(parseRecentTabs(null), []);
  assert.deepEqual(parseRecentTabs('%3, %1, bad, %3, %12, foo%2'), ['%3', '%1', '%12']);
});

test('pushRecentTab records current and previous tab and toggles order', () => {
  assert.deepEqual(pushRecentTab([], '%2', '%1'), ['%2', '%1']);
  assert.deepEqual(pushRecentTab(['%2', '%1'], '%1', '%2'), ['%1', '%2']);
  assert.deepEqual(pushRecentTab(['%1', '%2'], '%3', '%1'), ['%3', '%1', '%2']);
  // Clicking the already visible tab keeps the rest of the history intact
  assert.deepEqual(pushRecentTab(['%3', '%1', '%2'], '%3', ''), ['%3', '%1', '%2']);
  assert.deepEqual(pushRecentTab(['%3', '%1', '%2'], '%3', '%3'), ['%3', '%1', '%2']);
});

test('pushRecentTab prunes closed panes while keeping newly created paneId', () => {
  const live = new Set(['%1', '%3']);
  assert.deepEqual(pushRecentTab(['%2', '%3', '%1'], '%4', '%1', live), ['%4', '%1', '%3']);
  assert.deepEqual(pushRecentTab(['%2', '%3', '%1'], '%1', '', live), ['%1', '%3']);
});

test('findInitialSelection picks the last used tab across same or different bookmarks', () => {
  const rows = [
    { type: 'bookmark', index: 0 },
    { type: 'tab', tab: { paneId: '%1', visible: false } },
    { type: 'tab', tab: { paneId: '%2', visible: true } },
    { type: 'bookmark', index: 1 },
    { type: 'tab', tab: { paneId: '%3', visible: false } },
    { type: 'tab', tab: { paneId: '%4', visible: false } }
  ];

  // Same bookmark: %2 is visible, %1 was used right before it
  assert.deepEqual(findInitialSelection(rows, ['%2', '%1', '%3']), { index: 1, previousTabId: '%1' });

  // Different bookmark: %2 is visible, %4 (tab 2 of bookmark 1) was used before it
  assert.deepEqual(findInitialSelection(rows, ['%2', '%4', '%3', '%1']), { index: 5, previousTabId: '%4' });

  // Closed pane (%99) in history is skipped for the next live tab (%3)
  assert.deepEqual(findInitialSelection(rows, ['%2', '%99', '%3']), { index: 4, previousTabId: '%3' });
});

test('findInitialSelection falls back cleanly when no previous live tab exists', () => {
  const twoBookmarksOneTab = [
    { type: 'bookmark', index: 0 },
    { type: 'tab', tab: { paneId: '%1', visible: true } },
    { type: 'bookmark', index: 1 }
  ];
  assert.deepEqual(findInitialSelection(twoBookmarksOneTab, ['%1']), { index: 2, previousTabId: null });

  const oneBookmarkTwoTabs = [
    { type: 'bookmark', index: 0 },
    { type: 'tab', tab: { paneId: '%1', visible: true } },
    { type: 'tab', tab: { paneId: '%2', visible: false } }
  ];
  assert.deepEqual(findInitialSelection(oneBookmarkTwoTabs, []), { index: 2, previousTabId: '%2' });

  const singleTab = [
    { type: 'bookmark', index: 0 },
    { type: 'tab', tab: { paneId: '%1', visible: true } }
  ];
  assert.deepEqual(findInitialSelection(singleTab, ['%1']), { index: 0, previousTabId: null });
  assert.deepEqual(findInitialSelection([], []), { index: 0, previousTabId: null });
});

function makeApp({ bookmarks, panesList, activeId, recentHistory, recentTabs }) {
  const switched = [];
  const panesMap = new Map();
  for (const p of panesList) {
    if (!panesMap.has(p.bookmark)) panesMap.set(p.bookmark, []);
    panesMap.get(p.bookmark).push(p);
  }
  const app = new SwitcherApp({
    config: { bookmarks, agents: [], switcherKey: 'C-e' },
    activeId,
    recentHistory,
    recentTabs,
    getSessionPanes: () => ({ panes: panesMap, all: panesList }),
    loadManualStatuses: () => ({}),
    rememberedTab: key => {
      const tabs = panesMap.get(key) || [];
      return tabs[0] ? tabs[0].paneId : '';
    },
    switchToBookmark: (bm, cmd, focus, tabPaneId) => {
      switched.push({ id: bm.id, cmd, focus, tabPaneId });
    }
  });
  app.exit = () => {};
  return { app, switched };
}

test('SwitcherApp: Ctrl+E -> Enter toggles to the last used tab in the same project', () => {
  const bmA = { id: 'a', name: 'Project A', path: '/tmp/a' };
  const bmB = { id: 'b', name: 'Project B', path: '/tmp/b' };
  const { app, switched } = makeApp({
    bookmarks: [bmA, bmB],
    activeId: 'a',
    recentHistory: ['a', 'b'],
    recentTabs: ['%2', '%1', '%3'],
    panesList: [
      { paneId: '%1', bookmark: 'a', command: 'claude', visible: false, status: '', path: '/tmp/a', title: '' },
      { paneId: '%2', bookmark: 'a', command: 'fish', visible: true, status: '', path: '/tmp/a', title: '' },
      { paneId: '%3', bookmark: 'b', command: 'bash', visible: false, status: '', path: '/tmp/b', title: '' }
    ]
  });

  assert.equal(app.previousTabId, '%1');
  app.handleKey('\r');
  assert.deepEqual(switched, [{ id: 'a', cmd: '', focus: true, tabPaneId: '%1' }]);

  const prevTabLine = stripAnsi(app.tabLine(app.rows[app.selectedIndex], true, 62));
  const otherBookmarkLine = stripAnsi(app.bookmarkLine(app.rows.find(r => r.type === 'bookmark' && r.index === 1), false));
  assert.match(prevTabLine, /\(previous\)/);
  assert.doesNotMatch(otherBookmarkLine, /\(previous\)/);
});

test('SwitcherApp: Ctrl+E -> Enter toggles to the last used tab across projects', () => {
  const bmA = { id: 'a', name: 'Project A', path: '/tmp/a' };
  const bmB = { id: 'b', name: 'Project B', path: '/tmp/b' };
  const { app, switched } = makeApp({
    bookmarks: [bmA, bmB],
    activeId: 'b',
    recentHistory: ['b', 'a'],
    recentTabs: ['%3', '%2', '%1'],
    panesList: [
      { paneId: '%1', bookmark: 'a', command: 'claude', visible: false, status: '', path: '/tmp/a', title: '' },
      { paneId: '%2', bookmark: 'a', command: 'fish', visible: false, status: '', path: '/tmp/a', title: '' },
      { paneId: '%3', bookmark: 'b', command: 'bash', visible: true, status: '', path: '/tmp/b', title: '' }
    ]
  });

  assert.equal(app.previousTabId, '%2');
  app.handleKey('\r');
  assert.deepEqual(switched, [{ id: 'a', cmd: '', focus: true, tabPaneId: '%2' }]);
});

test('SwitcherApp: Ctrl+E -> Enter falls back to previous bookmark when only 1 tab is open', () => {
  const bmA = { id: 'a', name: 'Project A', path: '/tmp/a' };
  const bmB = { id: 'b', name: 'Project B', path: '/tmp/b' };
  const { app, switched } = makeApp({
    bookmarks: [bmA, bmB],
    activeId: 'a',
    recentHistory: ['a', 'b'],
    recentTabs: ['%1'],
    panesList: [
      { paneId: '%1', bookmark: 'a', command: 'claude', visible: true, status: '', path: '/tmp/a', title: '' }
    ]
  });

  assert.equal(app.previousTabId, null);
  app.handleKey('\r');
  assert.deepEqual(switched, [{ id: 'b', cmd: '', focus: true, tabPaneId: undefined }]);

  const otherBookmarkLine = stripAnsi(app.bookmarkLine(app.rows[app.selectedIndex], true));
  assert.match(otherBookmarkLine, /\(previous\)/);
});

test('SwitcherApp.tabLine fits within popup width with badge, current dot, and (previous)', () => {
  const bmA = { id: 'a', name: 'Project A', path: '/tmp/a' };
  const { app } = makeApp({
    bookmarks: [bmA],
    activeId: 'a',
    recentHistory: ['a'],
    recentTabs: ['%2', '%1'],
    panesList: [
      { paneId: '%1', bookmark: 'a', command: 'claude', visible: false, status: '', path: '/tmp/a', title: 'Fix a very long task description here' },
      { paneId: '%2', bookmark: 'a', command: 'fish', visible: true, status: '', path: '/tmp/a', title: '' }
    ]
  });
  const row = {
    ...app.rows[1],
    isCurrent: true,
    status: STATUS_TYPES.INPUT_REQUIRED
  };
  const rendered = stripAnsi(app.tabLine(row, true, 62));
  assert.match(rendered, /\(previous\)/);
  assert.ok(cellWidth(rendered) <= 61, `tabLine width was ${cellWidth(rendered)}`);
});
