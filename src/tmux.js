const { execFileSync } = require('child_process');
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

function windowTarget(key) {
  return `${SESSION_NAME}:_pane_${key}`;
}

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

function statusRight(switcherKey, alert = false) {
  const hints = `#[fg=#a6adc8]${keyLabel(switcherKey)}: Switcher │ Alt+←/Alt+h: Menu │ F3: Mouse #[default]`;
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

function listWindowNames() {
  const out = tmuxQuiet(['list-windows', '-t', SESSION_NAME, '-F', '#{window_name}']);
  return out ? out.split('\n').map(s => s.trim()).filter(Boolean) : [];
}

function hasBookmarkWindow(bookmarkKey) {
  return listWindowNames().includes(`_pane_${sanitizeKey(bookmarkKey)}`);
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

function switchToBookmark(targetBookmark, agentCommand = '', focus = true) {
  if (!targetBookmark) return;
  const targetId = getBookmarkKey(targetBookmark);
  const currentId = getActiveBookmarkId();

  if (targetId !== currentId && currentId) {
    // 1. Ensure the target bookmark's background window exists
    if (!hasBookmarkWindow(targetId)) {
      tmuxQuiet([
        'new-window', '-d', '-t', `${SESSION_NAME}:`, '-n', `_pane_${targetId}`,
        '-c', targetBookmark.path, userShell()
      ]);
    }

    // 2. Swap the visible right pane with the target's background pane
    tmuxQuiet(['swap-pane', '-s', TERMINAL_PANE, '-t', `${windowTarget(targetId)}.0`]);

    // 3. Remove a stale window that would collide with the new name
    if (hasBookmarkWindow(currentId)) {
      tmuxQuiet(['kill-window', '-t', windowTarget(currentId)]);
    }

    // 4. The background window now holds the previous pane: rename it
    tmuxQuiet(['rename-window', '-t', windowTarget(targetId), `_pane_${currentId}`]);
  }

  // 5. Optionally launch a command in the now visible pane
  sendCommand(TERMINAL_PANE, agentCommand);

  // 6. Persist active bookmark (tmux option + config history/selection)
  if (targetId !== currentId) {
    setActiveBookmarkId(targetId);
    recordActiveSession(targetId);
  }

  if (focus) focusPane(1);
}

function closeBookmarkSession(bookmarkKeyOrObj) {
  const key = sanitizeKey(bookmarkKeyOrObj);
  if (hasBookmarkWindow(key)) {
    tmuxQuiet(['kill-window', '-t', windowTarget(key)]);
  }
}

/** Number of panes in the main window (-1 if the session is gone). */
function getMainWindowPaneCount() {
  const out = tmuxQuiet(['display-message', '-p', '-t', `${SESSION_NAME}:0`, '#{window_panes}']);
  return out === null ? -1 : parseInt(out.trim(), 10);
}

/** Recreate the right terminal pane (e.g. after the user typed `exit`). */
function respawnTerminalPane(dir, width) {
  tmuxQuiet(['split-window', '-h', '-d', '-t', SIDEBAR_PANE, '-c', dir || process.cwd(), userShell()]);
  setSidebarWidth(width);
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

function bindKeys({ switcherKey, popupCommand }) {
  const bind = (...args) => tmuxQuiet(['bind-key', ...args]);

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
  const switcherKey = config.switcherKey || 'C-e';

  const initialBookmarkObj = initialBookmark || config.bookmarks[0] || null;
  const initialDir = initialBookmarkObj ? initialBookmarkObj.path : process.cwd();
  const initialId = getBookmarkKey(initialBookmarkObj);
  const width = clampWidth(initialWidth);

  const termCols = process.stdout.columns >= 40 ? process.stdout.columns : 180;
  const termRows = process.stdout.rows >= 10 ? process.stdout.rows : 40;

  // 1. Session with the sidebar in pane 0 (the server inherits our env, incl. XDG_CONFIG_HOME)
  tmux(['new-session', '-d', '-s', SESSION_NAME, '-n', 'CLI-Agent', '-x', termCols, '-y', termRows, sidebarCmd]);

  // 2. Terminal pane on the right
  tmux(['split-window', '-h', '-t', SIDEBAR_PANE, '-c', initialDir, userShell()]);

  // 3. Sidebar width, re-applied whenever a client attaches
  setSidebarWidth(width);
  tmuxQuiet(['set-hook', '-t', SESSION_NAME, 'client-attached', `resize-pane -t ${SIDEBAR_PANE} -x ${width}`]);

  // 4. Options (dedicated server: global options only affect CLI-Agent)
  const opt = (...args) => tmuxQuiet(['set-option', ...args]);
  opt('-g', 'mouse', 'on');
  opt('-s', 'set-clipboard', 'on');
  opt('-s', 'escape-time', '10');
  opt('-t', SESSION_NAME, 'status', 'on');
  opt('-t', SESSION_NAME, 'status-style', 'bg=#1e1e2e,fg=#cdd6f4');
  opt('-t', SESSION_NAME, 'status-left', '#[bold,fg=#89b4fa] 🤖 CLI-AGENT #[default]│ ');
  opt('-t', SESSION_NAME, 'status-left-length', '30');
  opt('-t', SESSION_NAME, 'status-right-length', '90');
  opt('-t', SESSION_NAME, 'status-right', statusRight(switcherKey));
  opt('-t', SESSION_NAME, 'pane-border-style', 'fg=#313244');
  opt('-t', SESSION_NAME, 'pane-active-border-style', 'fg=#89b4fa');
  opt('-t', SESSION_NAME, '@switcher_key', switcherKey);

  // 5. Key bindings
  bindKeys({ switcherKey, popupCommand });

  // 6. Initial focus and state
  focusPane(0);
  setActiveBookmarkId(initialId);
  recordActiveSession(initialId);

  // 7. Attach
  attach();
}

module.exports = {
  SESSION_NAME,
  SOCKET,
  DEFAULT_SIDEBAR_WIDTH,
  isTmuxInstalled,
  getTmuxVersion,
  isInsideTmux,
  isInsideCliAgent,
  sessionExists,
  keyLabel,
  statusRight,
  getActiveBookmarkId,
  setActiveBookmarkId,
  hasBookmarkWindow,
  switchToBookmark,
  closeBookmarkSession,
  getMainWindowPaneCount,
  respawnTerminalPane,
  resizeSidebar,
  setSidebarWidth,
  getPaneWidths,
  focusPane,
  setStatusRight,
  killSession,
  startWorkspace
};
