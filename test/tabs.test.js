const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-agent-test-'));
process.env.XDG_CONFIG_HOME = tmpHome;

const { buildTabBar, cellWidth, tabsOf, newTabKeyOf, statusRight } = require('../src/tmux');
const { mostImportantStatus, STATUS_TYPES: S } = require('../src/monitor');

test.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

test('cellWidth counts emoji as two columns', () => {
  assert.equal(cellWidth('abc'), 3);
  assert.equal(cellWidth(' 📁 x'), 5);
  assert.equal(cellWidth('é'), 1);
});

test('buildTabBar: the tabs start right above the terminal pane', () => {
  const bar = buildTabBar({ name: 'Projet', tabs: [], sidebarWidth: 26 });
  const plain = bar.replace(/#\[[^\]]*\]/g, '');
  // name block is exactly the sidebar width, then the pane border column
  assert.equal(cellWidth(plain.split('│')[0]), 26);
  assert.match(bar, /#\[range=user\|newtab\]/);
});

test('buildTabBar: one clickable tab per pane, numbered, with status icons', () => {
  const bar = buildTabBar({
    name: 'P',
    sidebarWidth: 20,
    tabs: [
      { paneId: '%1', command: 'claude', visible: false, status: 'input_required' },
      { paneId: '%7', command: 'bash', visible: true, status: '' }
    ]
  });
  assert.match(bar, /#\[range=user\|tab%1\]#\[bg=#f9e2af[^\]]*\] 1 🔔 claude /);
  assert.match(bar, /#\[range=user\|tab%7\]#\[bg=#89b4fa[^\]]*\] 2 bash /);
});

test('buildTabBar: long names are cut and # cannot inject tmux styles', () => {
  const bar = buildTabBar({ name: 'a-very-long-bookmark-name-indeed', sidebarWidth: 16, tabs: [{ paneId: '%2', command: '#[fg=red]x', visible: true }] });
  const plain = bar.replace(/#\[[^\]]*\]/g, '');
  assert.equal(cellWidth(plain.split('│')[0]), 16);
  assert.ok(plain.includes('…'));
  assert.ok(!bar.includes('#[fg=red]'));
});

test('tabsOf keeps the tabs of one bookmark in creation order', () => {
  const panes = [
    { paneId: '%12', bookmark: 'a' },
    { paneId: '%3', bookmark: 'b' },
    { paneId: '%9', bookmark: 'a' }
  ];
  assert.deepEqual(tabsOf(panes, 'a').map(p => p.paneId), ['%9', '%12']);
  assert.deepEqual(tabsOf(null, 'a'), []);
});

test('newTabKeyOf: Ctrl+T by default, configurable, "" disables', () => {
  assert.equal(newTabKeyOf({}), 'C-t');
  assert.equal(newTabKeyOf({ newTabKey: 'M-t' }), 'M-t');
  assert.equal(newTabKeyOf({ newTabKey: '' }), '');
  assert.match(statusRight('C-e', false, 'C-t'), /Ctrl\+T: New tab/);
  assert.doesNotMatch(statusRight('C-e', false, ''), /New tab/);
});

test('mostImportantStatus: a tab waiting for input wins over the others', () => {
  assert.equal(mostImportantStatus([S.IDLE, S.RUNNING, S.INPUT_REQUIRED, S.DONE]), S.INPUT_REQUIRED);
  assert.equal(mostImportantStatus([S.DONE, S.RUNNING]), S.RUNNING);
  assert.equal(mostImportantStatus([]), S.IDLE);
});
