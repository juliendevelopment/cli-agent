const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { SOCKET, SESSION_NAME, tmux, tmuxQuiet, tmuxInteractive, shQuote, commandExists } = require('./exec');
const {
  DEFAULT_SIDEBAR_WIDTH,
  clampWidth,
  recordActiveSession,
  getBookmarkKey,
  loadConfig
} = require('./config');

let activeBookmarkId = null;

const SIDEBAR_PANE = `${SESSION_NAME}:0.0`;
const TERMINAL_PANE = `${SESSION_NAME}:0.1`;

// Every terminal pane (tab) is tagged with the key of the bookmark it belongs
// to. Pane ids (%N) survive swap-pane / join-pane, so tabs are tracked by pane
// id, wherever tmux keeps them: the visible one is window 0 pane 1, the others
// live in hidden background windows.
const PANE_BOOKMARK_OPT = '@ca_bm';
const PANE_STATUS_OPT = '@ca_status';
const TAB_BAR_OPT = '@ca_tabs';
const DEFAULT_NEW_TAB_KEY = 'C-t';

function sanitizeKey(keyOrBookmark) {
  return typeof keyOrBookmark === 'object' && keyOrBookmark !== null
    ? getBookmarkKey(keyOrBookmark)
    : String(keyOrBookmark).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function isTmuxInstalled() {
  return commandExists('tmux');
}

function getTmuxVersion() {
  try {
    const out = execFileSync('tmux', ['-V'], { encoding: 'utf-8' }).trim();
    const m = out.match(/(\d+)\.(\d+)/);
    return m ? { major: +m[1], minor: +m[2], raw: out } : { major: 0, minor: 0, raw: out };
  } catch (err) {
    return null;
  }
}

function isInsideTmux() {
  return Boolean(process.env.TMUX);
}

/** True when running inside a pane of the CLI-Agent tmux server. */
function isInsideCliAgent() {
  if (!process.env.TMUX) return false;
  const socketPath = process.env.TMUX.split(',')[0];
  return path.basename(socketPath) === SOCKET;
}

function sessionExists(session = SESSION_NAME) {
  return tmuxQuiet(['has-session', '-t', session]) !== null;
}

/** Human readable label for a tmux key name (C-e -> Ctrl+E). */
function keyLabel(key) {
  return String(key)
    .replace(/^C-/, 'Ctrl+')
    .replace(/^M-/, 'Alt+')
    .replace(/\+([a-z])$/, (_, c) => '+' + c.toUpperCase());
}

/** Configured new-tab key ('' disables it). */
function newTabKeyOf(config) {
  return config && typeof config.newTabKey === 'string' ? config.newTabKey : DEFAULT_NEW_TAB_KEY;
}

function statusRight(switcherKey, alert = false, newTabKey = DEFAULT_NEW_TAB_KEY) {
  const tabHint = newTabKey ? `${keyLabel(newTabKey)}: New tab │ ` : '';
  const hints = `#[fg=#a6adc8]${tabHint}${keyLabel(switcherKey)}: Switcher │ Alt+←: Menu │ F3: Mouse #[default]`;
  return alert ? `#[bg=yellow,fg=black,bold] 🔔 ACTION REQUIRED #[default] │ ${hints}` : hints;
}

function getActiveBookmarkId() {
  const val = (tmuxQuiet(['show-options', '-t', SESSION_NAME, '-qv', '@active_bookmark_id']) || '').trim();
  if (val) return val;
  if (activeBookmarkId) return activeBookmarkId;
  try {
    const cfg = loadConfig();
    return cfg.activeBookmarkId || (cfg.bookmarks[0] ? getBookmarkKey(cfg.bookmarks[0]) : null);
  } catch (err) {
    return null;
  }
}

function setActiveBookmarkId(id) {
  if (!id) return;
  activeBookmarkId = id;
  tmuxQuiet(['set-option', '-t', SESSION_NAME, '@active_bookmark_id', id]);
}

function userShell() {
  return process.env.SHELL || '/bin/bash';
}

/** Type a command into a pane literally, then press Enter. */
function sendCommand(target, command) {
  const cmd = String(command || '').trim();
  if (!cmd) return;
  tmuxQuiet(['send-keys', '-t', target, '-l', cmd]);
  tmuxQuiet(['send-keys', '-t', target, 'Enter']);
}

// ---------------------------------------------------------------------------
// Panes & tabs
// ---------------------------------------------------------------------------

function paneNumber(paneId) {
  return parseInt(String(paneId).replace(/^%/, ''), 10) || 0;
}

/**
 * Every terminal pane of the session (the sidebar excluded), or null when the
 * session is gone: { paneId, pid, command, bookmark, visible, status }.
 */
function listSessionPanes() {
  const fields = [
    '#{pane_id}', '#{window_index}', '#{pane_index}', '#{window_name}', '#{pane_pid}',
    '#{pane_current_command}', `#{${PANE_BOOKMARK_OPT}}`, `#{${PANE_STATUS_OPT}}`
  ];
  const out = tmuxQuiet(['list-panes', '-s', '-t', SESSION_NAME, '-F', fields.join('\t')]);
  if (out === null) return null;

  const panes = [];
  let activeId;
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [paneId, winIndex, paneIndex, winName, pid, command, tag, status] = line.split('\t');
    if (winIndex === '0' && paneIndex === '0') continue; // sidebar
    const visible = winIndex === '0' && paneIndex === '1';
    let bookmark = tag || '';
    // Sessions started by an older version: windows named _pane_<key>
    if (!bookmark && winName && winName.startsWith('_pane_')) bookmark = winName.slice('_pane_'.length);
    if (!bookmark && visible) {
      if (activeId === undefined) activeId = getActiveBookmarkId();
      bookmark = activeId || '';
    }
    panes.push({ paneId, pid: parseInt(pid, 10), command: command || '', bookmark, visible, status: status || '' });
  }
  return panes;
}

/** Tabs of a bookmark, in creation order. */
function tabsOf(panes, key) {
  return (panes || []).filter(p => p.bookmark === key).sort((a, b) => paneNumber(a.paneId) - paneNumber(b.paneId));
}

function tagPane(paneId, key) {
  tmuxQuiet(['set-option', '-p', '-t', paneId, PANE_BOOKMARK_OPT, key]);
}

function setPaneStatus(paneId, statusId) {
  tmuxQuiet(['set-option', '-p', '-t', paneId, PANE_STATUS_OPT, statusId || '']);
}

function rememberTab(key, paneId) {
  if (key && paneId) tmuxQuiet(['set-option', '-t', SESSION_NAME, `@ca_tab_${key}`, paneId]);
}

function rememberedTab(key) {
  return (tmuxQuiet(['show-options', '-t', SESSION_NAME, '-qv', `@ca_tab_${key}`]) || '').trim();
}

function bookmarkDir(bookmark) {
  return bookmark && bookmark.path && fs.existsSync(bookmark.path) ? bookmark.path : process.cwd();
}

/** New shell for a bookmark in a hidden window. Returns its pane id. */
function createBackgroundPane(bookmark) {
  const out = tmuxQuiet([
    'new-window', '-d', '-t', `${SESSION_NAME}:`, '-n', '_tab', '-c', bookmarkDir(bookmark),
    '-P', '-F', '#{pane_id}', userShell()
  ]);
  const paneId = out ? out.trim() : '';
  if (paneId) tagPane(paneId, getBookmarkKey(bookmark));
  return paneId;
}

/** Current sidebar width (live when possible, otherwise from the config). */
function currentSidebarWidth() {
  const w = getPaneWidths();
  if (w && w.panes >= 2 && w.paneWidth >= 16 && w.paneWidth <= 60) return w.paneWidth;
  try {
    return clampWidth(loadConfig().sidebarWidth);
  } catch (err) {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

/** Put a pane in the visible right slot (the previous one goes to the background). */
function showPane(paneId, panes) {
  const all = panes || listSessionPanes() || [];
  const visible = all.find(p => p.visible);
  const target = all.find(p => p.paneId === paneId);
  if (visible && visible.paneId === paneId) {
    rememberTab(visible.bookmark, paneId);
    return true;
  }
  let ok;
  if (visible) {
    rememberTab(visible.bookmark, visible.paneId);
    ok = tmuxQuiet(['swap-pane', '-d', '-s', paneId, '-t', visible.paneId]) !== null;
  } else {
    // The right pane is gone (its shell exited): move the target next to the sidebar
    const width = currentSidebarWidth();
    ok = tmuxQuiet(['join-pane', '-h', '-d', '-s', paneId, '-t', SIDEBAR_PANE]) !== null;
    setSidebarWidth(width);
  }
  if (ok && target) rememberTab(target.bookmark, paneId);
  return ok;
}

function switchToBookmark(targetBookmark, agentCommand = '', focus = true) {
  if (!targetBookmark) return;
  const targetId = getBookmarkKey(targetBookmark);
  const currentId = getActiveBookmarkId();
  const panes = listSessionPanes() || [];
  const visible = panes.find(p => p.visible);

  if (!visible || visible.bookmark !== targetId) {
    // Bring back the tab that was last shown for this bookmark (or create one)
    const tabs = tabsOf(panes, targetId);
    const remembered = rememberedTab(targetId);
    const tab = tabs.find(t => t.paneId === remembered) || tabs[0];
    const paneId = tab ? tab.paneId : createBackgroundPane(targetBookmark);
    if (paneId) showPane(paneId, panes);
  }

  sendCommand(TERMINAL_PANE, agentCommand);

  if (targetId !== currentId) {
    setActiveBookmarkId(targetId);
    recordActiveSession(targetId);
  }
  refreshTabBar();
  if (focus) focusPane(1);
}

function findBookmarkByKey(key) {
  try {
    return loadConfig().bookmarks.find(b => getBookmarkKey(b) === key) || null;
  } catch (err) {
    return null;
  }
}

/** Open a new tab (shell in the bookmark directory) and show it. */
function newTab(bookmark = null, agentCommand = '') {
  const bm = bookmark || findBookmarkByKey(getActiveBookmarkId());
  if (!bm) return null;
  const key = getBookmarkKey(bm);
  const panes = listSessionPanes() || [];
  const paneId = createBackgroundPane(bm);
  if (!paneId) return null;
  showPane(paneId, panes);
  sendCommand(TERMINAL_PANE, agentCommand);
  if (key !== getActiveBookmarkId()) {
    setActiveBookmarkId(key);
    recordActiveSession(key);
  }
  refreshTabBar();
  focusPane(1);
  return paneId;
}

/** Tabs of the active bookmark and the index of the visible one. */
function activeTabs() {
  const panes = listSessionPanes() || [];
  const tabs = tabsOf(panes, getActiveBookmarkId());
  return { panes, tabs, index: tabs.findIndex(t => t.visible) };
}

function showTab(tab, panes) {
  if (!tab) return;
  showPane(tab.paneId, panes);
  refreshTabBar();
  focusPane(1);
}

/** Select the n-th tab (1-based) of the active bookmark. */
function selectTab(n) {
  const { panes, tabs } = activeTabs();
  showTab(tabs[n - 1], panes);
}

/** Next (+1) / previous (-1) tab, wrapping around. */
function cycleTab(delta) {
  const { panes, tabs, index } = activeTabs();
  if (tabs.length < 2) return;
  const from = index === -1 ? 0 : index;
  showTab(tabs[(from + delta + tabs.length) % tabs.length], panes);
}

/** Select a tab by pane id (mouse click on the tab bar). */
function selectTabPane(paneId) {
  const { panes, tabs } = activeTabs();
  showTab(tabs.find(t => t.paneId === paneId), panes);
}

/**
 * The visible shell exited (window 0 only holds the sidebar): show the next
 * tab of the active bookmark, or start a fresh shell when it was the last one.
 * Returns true when the right pane had to be restored.
 */
function ensureTerminalPane() {
  if (getMainWindowPaneCount() !== 1) return false;
  const key = getActiveBookmarkId();
  const panes = listSessionPanes() || [];
  const tabs = tabsOf(panes, key);
  if (tabs.length > 0) {
    // Like a browser: the tab to the right of the closed one, else the last
    const closed = paneNumber(rememberedTab(key));
    const next = tabs.find(t => paneNumber(t.paneId) > closed) || tabs[tabs.length - 1];
    showPane(next.paneId, panes);
  } else {
    const width = currentSidebarWidth();
    const out = tmuxQuiet([
      'split-window', '-h', '-d', '-t', SIDEBAR_PANE, '-c', bookmarkDir(findBookmarkByKey(key)),
      '-P', '-F', '#{pane_id}', userShell()
    ]);
    const paneId = out ? out.trim() : '';
    if (paneId && key) {
      tagPane(paneId, key);
      rememberTab(key, paneId);
    }
    setSidebarWidth(width);
  }
  refreshTabBar();
  // The user was typing in the closed tab: keep the keyboard on the terminal
  focusPane(1);
  return true;
}

/** Close every hidden tab of a bookmark (the visible one is left alone). */
function closeBookmarkSession(bookmarkKeyOrObj) {
  const key = sanitizeKey(bookmarkKeyOrObj);
  for (const tab of tabsOf(listSessionPanes(), key)) {
    if (!tab.visible) tmuxQuiet(['kill-pane', '-t', tab.paneId]);
  }
  tmuxQuiet(['set-option', '-u', '-t', SESSION_NAME, `@ca_tab_${key}`]);
}

// ---------------------------------------------------------------------------
// Tab bar (tmux status line, at the top)
// ---------------------------------------------------------------------------

const TAB_ICONS = {
  input_required: '🔔',
  running: '⚡',
  done: '✓',
  error: '✗',
  rate_limit: '⏳'
};

/** Make text safe inside a tmux format / style string. */
function tmuxText(text) {
  return String(text || '').replace(/[#\t\r\n]/g, '');
}

/** Terminal columns taken by a string (emoji and CJK are 2 columns wide). */
function cellWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (cp === 0xfe0f || cp === 0x200d) continue;
    const wide = cp >= 0x1f000 ||
      (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60);
    width += wide ? 2 : 1;
  }
  return width;
}

function fitText(text, max) {
  if (cellWidth(text) <= max) return text;
  let out = '';
  for (const ch of text) {
    if (cellWidth(out + ch) > max - 1) break;
    out += ch;
  }
  return out + '…';
}

/**
 * Build the tab bar (a tmux format string): the bookmark name above the
 * sidebar, then one clickable tab per pane and a "+" button above the terminal.
 */
function buildTabBar({ name = '', tabs = [], sidebarWidth = DEFAULT_SIDEBAR_WIDTH }) {
  const left = fitText(` 📁 ${tmuxText(name)}`, Math.max(4, sidebarWidth - 1));
  const pad = ' '.repeat(Math.max(0, sidebarWidth - cellWidth(left)));
  let bar = `#[fg=#89b4fa,bold]${left}${pad}#[default]#[fg=#45475a]│#[default]`;

  tabs.forEach((tab, i) => {
    const icon = TAB_ICONS[tab.status] ? `${TAB_ICONS[tab.status]} ` : '';
    const label = fitText(tmuxText(tab.command) || 'shell', 16);
    let style;
    if (tab.visible) style = 'bg=#89b4fa,fg=#1e1e2e,bold';
    else if (tab.status === 'input_required') style = 'bg=#f9e2af,fg=#1e1e2e,bold';
    else style = 'bg=#313244,fg=#cdd6f4';
    bar += ` #[range=user|tab${tab.paneId}]#[${style}] ${i + 1} ${icon}${label} #[default]#[norange]`;
  });
  bar += ' #[range=user|newtab]#[fg=#a6e3a1,bold] + #[default]#[norange]';
  return bar;
}

let lastTabBar = null;

/** Recompute the tab bar of the active bookmark (only touches tmux on change). */
function refreshTabBar(panes = null) {
  const all = panes || listSessionPanes();
  if (!all) return;
  const key = getActiveBookmarkId();
  const bm = findBookmarkByKey(key);
  const value = buildTabBar({
    name: bm ? bm.name : '',
    tabs: tabsOf(all, key),
    sidebarWidth: currentSidebarWidth()
  });
  if (value === lastTabBar) return;
  lastTabBar = value;
  tmuxQuiet(['set-option', '-t', SESSION_NAME, TAB_BAR_OPT, value]);
  // Window title of the host terminal: "CLI-Agent · <bookmark>"
  tmuxQuiet(['set-option', '-t', SESSION_NAME, '@ca_title', bm ? ` · ${tmuxText(bm.name)}` : '']);
}

/** Entry point of `cli-agent --tab <action>` (run by tmux key / mouse bindings). */
function handleTabCommand(args) {
  const [action, arg] = args;
  switch (action) {
    case 'new':
      return newTab();
    case 'select':
      return selectTab(parseInt(arg, 10));
    case 'next':
      return cycleTab(1);
    case 'prev':
      return cycleTab(-1);
    case 'click':
      if (arg === 'newtab') return newTab();
      if (arg && arg.startsWith('tab%')) return selectTabPane(arg.slice(3));
      return undefined;
    case 'ensure':
      if (!ensureTerminalPane()) refreshTabBar();
      return undefined;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Number of panes in the main window (-1 if the session is gone). */
function getMainWindowPaneCount() {
  const out = tmuxQuiet(['display-message', '-p', '-t', `${SESSION_NAME}:0`, '#{window_panes}']);
  return out === null ? -1 : parseInt(out.trim(), 10);
}

function resizeSidebar(delta) {
  const dir = delta < 0 ? '-L' : '-R';
  return tmuxQuiet(['resize-pane', '-t', SIDEBAR_PANE, dir, Math.abs(delta)]) !== null;
}

function setSidebarWidth(width) {
  return tmuxQuiet(['resize-pane', '-t', SIDEBAR_PANE, '-x', clampWidth(width)]) !== null;
}

function getPaneWidths() {
  const out = tmuxQuiet(['display-message', '-p', '-t', SIDEBAR_PANE, '#{window_panes} #{pane_width} #{window_width}']);
  if (!out) return null;
  const [panes, paneWidth, windowWidth] = out.trim().split(' ').map(n => parseInt(n, 10));
  return { panes, paneWidth, windowWidth };
}

function focusPane(paneIndex = 0) {
  return tmuxQuiet(['select-pane', '-t', `${SESSION_NAME}:0.${paneIndex}`]) !== null;
}

function setStatusRight(value) {
  tmuxQuiet(['set-option', '-t', SESSION_NAME, 'status-right', value]);
}

function killSession(session = SESSION_NAME) {
  return tmuxQuiet(['kill-session', '-t', session]) !== null;
}

/**
 * Earlier versions bound keys on the user's *default* tmux server. Remove
 * those leftovers (only bindings that reference CLI-Agent) when no legacy
 * session is running there.
 */
function cleanupLegacyBindings() {
  const run = args => {
    try {
      return execFileSync('tmux', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
    } catch (err) {
      return null;
    }
  };
  if (run(['has-session', '-t', SESSION_NAME]) !== null) return;
  const keys = run(['list-keys', '-T', 'root']);
  if (!keys) return;
  for (const line of keys.split('\n')) {
    if (!/--switcher|cli_agent/.test(line)) continue;
    const m = line.match(/bind-key\s+(?:-r\s+)?-T\s+root\s+(\S+)/);
    if (m) run(['unbind-key', '-n', m[1]]);
  }
}

function bindKeys({ switcherKey, newTabKey, popupCommand, tabCommand }) {
  const bind = (...args) => tmuxQuiet(['bind-key', ...args]);
  const tab = action => ['run-shell', '-b', `${tabCommand} ${action}`];

  // Quick switcher popup (tmux >= 3.3 for styled borders, fallback for 3.2)
  const keys = [...new Set([switcherKey, 'M-e'])];
  for (const key of keys) {
    const ok = bind('-n', key, 'display-popup', '-w', '56', '-h', '15', '-b', 'rounded',
      '-s', 'bg=#1e1e2e,fg=#cdd6f4', '-S', 'fg=#89b4fa', '-T', ' Recent Sessions ', '-E', popupCommand);
    if (ok === null) bind('-n', key, 'display-popup', '-w', '56', '-h', '15', '-E', popupCommand);
  }

  bind('-n', 'M-Left', 'select-pane', '-t', SIDEBAR_PANE);
  bind('-n', 'M-Right', 'select-pane', '-t', TERMINAL_PANE);
  bind('-n', 'M-h', 'select-pane', '-t', SIDEBAR_PANE);
  bind('-n', 'M-l', 'select-pane', '-t', TERMINAL_PANE);
  bind('-n', 'F1', 'select-pane', '-t', SIDEBAR_PANE);
  bind('-n', 'F2', 'select-pane', '-t', TERMINAL_PANE);
  bind('-n', 'F3', 'set-option', '-g', 'mouse');
  bind('-n', 'M-[', 'resize-pane', '-t', SIDEBAR_PANE, '-L', '3');
  bind('-n', 'M-]', 'resize-pane', '-t', SIDEBAR_PANE, '-R', '3');

  // Tabs: new tab, Alt+1..9, Ctrl+PgUp/PgDn, clicks on the tab bar
  if (newTabKey) bind('-n', newTabKey, ...tab('new'));
  for (let n = 1; n <= 9; n++) bind('-n', `M-${n}`, ...tab(`select ${n}`));
  bind('-n', 'C-PPage', ...tab('prev'));
  bind('-n', 'C-NPage', ...tab('next'));
  bind('-n', 'MouseDown1Status', ...tab("click '#{mouse_status_range}'"));

  // Mouse selections go to the system clipboard (Wayland / X11 / macOS / OSC 52)
  const clipCmd = 'wl-copy 2>/dev/null || xclip -in -selection clipboard 2>/dev/null || pbcopy 2>/dev/null || true';
  for (const table of ['copy-mode', 'copy-mode-vi']) {
    bind('-T', table, 'MouseDragEnd1Pane', 'send-keys', '-X', 'copy-pipe-and-cancel', clipCmd);
    bind('-T', table, 'DoubleClick1Pane', 'select-pane', ';', 'send-keys', '-X', 'select-word', ';',
      'send-keys', '-X', 'copy-pipe-and-cancel', clipCmd);
    bind('-T', table, 'TripleClick1Pane', 'select-pane', ';', 'send-keys', '-X', 'select-line', ';',
      'send-keys', '-X', 'copy-pipe-and-cancel', clipCmd);
  }
}

function attach() {
  // Terminals that name tabs after the foreground process (Konsole "%d : %n",
  // GNOME Console…) show "cli-agent" instead of "node".
  try {
    process.title = 'cli-agent';
  } catch (err) {
    // not supported on this platform
  }
  // Allow running from inside another tmux (nested client on a separate server).
  const env = { ...process.env };
  delete env.TMUX;
  tmuxInteractive(['attach-session', '-t', SESSION_NAME], env);
}

function startWorkspace({ initialBookmark, scriptPath, initialWidth = DEFAULT_SIDEBAR_WIDTH }) {
  if (!isTmuxInstalled()) {
    console.error('Error: tmux is not installed on this system.');
    console.error('Please install tmux (e.g. sudo apt install tmux or sudo dnf install tmux).');
    process.exit(1);
  }

  if (isInsideCliAgent()) {
    console.error('You are already inside CLI-Agent. Use the sidebar (Alt+←) or the switcher.');
    process.exit(1);
  }

  cleanupLegacyBindings();

  if (sessionExists()) {
    attach();
    return;
  }

  const config = loadConfig();
  const nodeBin = process.execPath;
  const entry = path.resolve(scriptPath);
  const sidebarCmd = `${shQuote(nodeBin)} ${shQuote(entry)} --sidebar`;
  const popupCommand = `${shQuote(nodeBin)} ${shQuote(entry)} --switcher`;
  const tabCommand = `${shQuote(nodeBin)} ${shQuote(entry)} --tab`;
  const switcherKey = config.switcherKey || 'C-e';
  const newTabKey = newTabKeyOf(config);

  const initialBookmarkObj = initialBookmark || config.bookmarks[0] || null;
  const initialDir = bookmarkDir(initialBookmarkObj);
  const initialId = getBookmarkKey(initialBookmarkObj);
  const width = clampWidth(initialWidth);

  const termCols = process.stdout.columns >= 40 ? process.stdout.columns : 180;
  const termRows = process.stdout.rows >= 10 ? process.stdout.rows : 40;

  // 1. Session with the sidebar in pane 0 (the server inherits our env, incl. XDG_CONFIG_HOME)
  tmux(['new-session', '-d', '-s', SESSION_NAME, '-n', 'CLI-Agent', '-x', termCols, '-y', termRows, sidebarCmd]);

  // 2. Terminal pane on the right (first tab of the initial bookmark)
  const firstPane = tmux(['split-window', '-h', '-t', SIDEBAR_PANE, '-c', initialDir, '-P', '-F', '#{pane_id}', userShell()]).trim();
  if (firstPane && initialBookmarkObj) {
    tagPane(firstPane, initialId);
    rememberTab(initialId, firstPane);
  }

  // 3. Sidebar width, re-applied whenever a client attaches
  setSidebarWidth(width);
  tmuxQuiet(['set-hook', '-t', SESSION_NAME, 'client-attached', `resize-pane -t ${SIDEBAR_PANE} -x ${width}`]);

  // 4. Options (dedicated server: global options only affect CLI-Agent)
  const opt = (...args) => tmuxQuiet(['set-option', ...args]);
  opt('-g', 'mouse', 'on');
  opt('-s', 'set-clipboard', 'on');
  opt('-s', 'escape-time', '10');
  opt('-t', SESSION_NAME, 'status', 'on');
  // Title of the host terminal window / tab (instead of "node")
  opt('-g', 'set-titles', 'on');
  opt('-g', 'set-titles-string', 'CLI-Agent#{@ca_title}');
  // Konsole names its tabs "%d : %n" and ignores the window title: send the
  // title with Konsole's own "tab title" sequence (OSC 30) instead.
  if (process.env.KONSOLE_VERSION || process.env.KONSOLE_DBUS_SESSION) {
    opt('-as', 'terminal-overrides', ',*:tsl=\\E]30;:fsl=^G');
  }
  opt('-t', SESSION_NAME, 'status-position', 'top');
  opt('-t', SESSION_NAME, 'status-style', 'bg=#1e1e2e,fg=#cdd6f4');
  opt('-t', SESSION_NAME, 'status-right-length', '90');
  opt('-t', SESSION_NAME, 'status-right', statusRight(switcherKey, false, newTabKey));
  // The status line is the tab bar: bookmark name, tabs, "+" and the hints
  opt('-t', SESSION_NAME, 'status-format[0]', `#[align=left]#{E:${TAB_BAR_OPT}}#[align=right]#{E:status-right}`);
  opt('-t', SESSION_NAME, 'pane-border-style', 'fg=#313244');
  opt('-t', SESSION_NAME, 'pane-active-border-style', 'fg=#89b4fa');
  opt('-t', SESSION_NAME, '@switcher_key', switcherKey);

  // 5. Key bindings, and closing a tab (its shell exits) shows the next one
  bindKeys({ switcherKey, newTabKey, popupCommand, tabCommand });
  tmuxQuiet(['set-hook', '-t', SESSION_NAME, 'pane-exited', `run-shell -b "${tabCommand.replace(/"/g, '\\"')} ensure"`]);

  // 6. Initial focus and state
  focusPane(0);
  setActiveBookmarkId(initialId);
  recordActiveSession(initialId);
  refreshTabBar();

  // 7. Attach
  attach();
}

module.exports = {
  SESSION_NAME,
  SOCKET,
  DEFAULT_SIDEBAR_WIDTH,
  DEFAULT_NEW_TAB_KEY,
  isTmuxInstalled,
  getTmuxVersion,
  isInsideTmux,
  isInsideCliAgent,
  sessionExists,
  keyLabel,
  newTabKeyOf,
  statusRight,
  getActiveBookmarkId,
  setActiveBookmarkId,
  listSessionPanes,
  tabsOf,
  setPaneStatus,
  switchToBookmark,
  newTab,
  selectTab,
  cycleTab,
  ensureTerminalPane,
  closeBookmarkSession,
  buildTabBar,
  cellWidth,
  refreshTabBar,
  handleTabCommand,
  getMainWindowPaneCount,
  resizeSidebar,
  setSidebarWidth,
  getPaneWidths,
  focusPane,
  setStatusRight,
  killSession,
  startWorkspace
};
