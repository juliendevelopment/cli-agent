const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-agent-test-'));
process.env.XDG_CONFIG_HOME = tmpHome;

const { buildTabBar, cellWidth, tabsOf, newTabKeyOf, statusRight, tabLabel, tabLabelText } = require('../src/tmux');
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
  assert.match(bar, /#\[range=user\|tab1\]#\[bg=#f9e2af[^\]]*\] {2}1 🔔 claude {2}/);
  assert.match(bar, /#\[range=user\|tab7\]#\[bg=#89b4fa[^\]]*\] {2}2 bash {2}/);
  // tmux expands "%" in the click command: range names must not contain it
  assert.doesNotMatch(bar, /range=user\|[^\]]*%/);
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

test('cellWidth: emoji of the BMP such as ⚡ and ⏳ are wide', () => {
  assert.equal(cellWidth('⚡'), 2);
  assert.equal(cellWidth('⏳'), 2);
  assert.equal(cellWidth('✓'), 1);
});

test('tabLabel: an agent tab shows the task its terminal title gives', () => {
  assert.deepEqual(tabLabel({ command: 'claude', title: '✳ Fix the login form' }), { name: 'claude', detail: 'Fix the login form' });
  assert.deepEqual(tabLabel({ command: 'claude', title: '⠂ Refactor tabs' }), { name: 'claude', detail: 'Refactor tabs' });
  assert.equal(tabLabelText({ command: 'copilot', title: 'Review PR 12' }), 'copilot · Review PR 12');
});

test('tabLabel: generic titles (agent name, hostname, path) are ignored', () => {
  assert.equal(tabLabelText({ command: 'claude', title: '✳ Claude Code' }), 'claude');
  assert.equal(tabLabelText({ command: 'copilot', title: 'GitHub Copilot' }), 'copilot');
  assert.equal(tabLabelText({ command: 'vim', title: os.hostname() }), 'vim');
  assert.equal(tabLabelText({ command: 'node', title: '~/Dev/x' }), 'node');
  assert.equal(tabLabelText({ command: '', title: '' }), 'shell');
});

test('tabLabel: a shell shows the folder it moved to, not its title', () => {
  assert.equal(tabLabelText({ command: 'fish', title: '~/D/S/proj: fish', path: '/home/u/proj' }, '/home/u/proj'), 'fish');
  assert.equal(tabLabelText({ command: 'fish', path: '/home/u/proj/web' }, '/home/u/proj'), 'fish · web');
  assert.equal(tabLabelText({ command: '-bash', path: '/home/u/proj' }, '/home/u/proj'), 'bash');
});

test('buildTabBar: tab names shrink so the bar fits the window', () => {
  const tabs = Array.from({ length: 4 }, (_, i) => ({ paneId: `%${i + 1}`, command: 'claude', title: 'A rather long task title here', visible: false }));
  const width = 160;
  const bar = buildTabBar({ name: 'P', sidebarWidth: 26, tabs, width, reserved: 60 });
  const plain = bar.replace(/#\[[^\]]*\]/g, '');
  assert.ok(cellWidth(plain) <= width - 60, `bar is ${cellWidth(plain)} columns`);
  assert.ok(plain.includes('claude'));
});

test('labelLimits: short names keep their size, long ones share the rest', () => {
  const { labelLimits } = require('../src/tmux');
  assert.deepEqual(labelLimits([4, 4, 40], 60), [4, 4, 32]);
  assert.deepEqual(labelLimits([4, 30, 30], 40), [4, 18, 18]);
  assert.deepEqual(labelLimits([20, 20], 4), [6, 6]);
  assert.deepEqual(labelLimits([10], Infinity), [10]);
});
