const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { stripAnsi, colors } = require('./ui');
const { tmuxQuiet, SESSION_NAME } = require('./exec');
const { getConfigDir, writeJsonAtomic } = require('./config');

// Manual statuses (from `cli-agent notify` / hooks) expire after this delay.
const MANUAL_STATUS_TTL_MS = 60 * 60 * 1000;

function getStatusFile() {
  return path.join(getConfigDir(), 'statuses.json');
}

const STATUS_TYPES = {
  INPUT_REQUIRED: { id: 'input_required', label: 'Action Required', icon: '🔔', ansiColor: colors.brightYellow },
  RUNNING: { id: 'running', label: 'Running...', icon: '⚡', ansiColor: colors.brightCyan },
  DONE: { id: 'done', label: 'Done', icon: '✓', ansiColor: colors.brightGreen },
  ERROR: { id: 'error', label: 'Error', icon: '✗', ansiColor: colors.brightRed },
  RATE_LIMIT: { id: 'rate_limit', label: 'Rate Limit', icon: '⏳', ansiColor: colors.brightMagenta },
  IDLE: { id: 'idle', label: 'Idle', icon: '●', ansiColor: colors.gray }
};

function statusById(id) {
  return Object.values(STATUS_TYPES).find(t => t.id === id) || STATUS_TYPES.IDLE;
}

/** Compact colored badge used by the sidebar and the switcher. */
function statusBadge(status) {
  switch (status && status.id) {
    case 'input_required': return `\x1b[43;30m${colors.bold} 🔔 ACTION \x1b[0m`;
    case 'running': return `\x1b[46;30m${colors.bold} ⚡ RUN \x1b[0m`;
    case 'done': return `${colors.brightGreen}✓ Done${colors.reset}`;
    case 'error': return `\x1b[41;37m${colors.bold} ✗ ERR \x1b[0m`;
    case 'rate_limit': return `\x1b[45;37m${colors.bold} ⏳ LIMIT \x1b[0m`;
    default: return `${colors.gray}● Idle${colors.reset}`;
  }
}

// ---------------------------------------------------------------------------
// Manual statuses
// ---------------------------------------------------------------------------

function loadManualStatuses() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getStatusFile(), 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

function saveManualStatus(bookmarkKey, statusKey, message = '') {
  const current = loadManualStatuses();
  current[bookmarkKey] = {
    status: statusKey,
    message,
    updatedAt: new Date().toISOString()
  };
  writeJsonAtomic(getStatusFile(), current);
}

function clearManualStatus(bookmarkKey) {
  const current = loadManualStatuses();
  if (!(bookmarkKey in current)) return;
  delete current[bookmarkKey];
  writeJsonAtomic(getStatusFile(), current);
}

/** Return the manual status entry for a bookmark if it is still fresh. */
function getManualStatus(statuses, key, now = Date.now()) {
  const entry = statuses && statuses[key];
  if (!entry || !entry.status || entry.status === 'idle') return null;
  const ts = Date.parse(entry.updatedAt);
  if (Number.isFinite(ts) && now - ts > MANUAL_STATUS_TTL_MS) return null;
  return entry;
}

/**
 * Combine a manual status with the auto-detected one.
 * A manual "running"/"input" status is dropped once the agent is no longer the
 * foreground process (the agent exited or was interrupted).
 */
function resolveStatus(manualEntry, detected, procInfo) {
  if (manualEntry) {
    const transient = manualEntry.status === 'running' || manualEntry.status === 'input_required';
    if (transient && procInfo && !procInfo.isAgent) {
      return detected;
    }
    // Live detection of a blocking prompt always wins over a stale "done".
    if (detected && detected.id === STATUS_TYPES.INPUT_REQUIRED.id) return detected;
    return statusById(manualEntry.status);
  }
  return detected || STATUS_TYPES.IDLE;
}

// ---------------------------------------------------------------------------
// tmux panes
// ---------------------------------------------------------------------------

/**
 * One tmux call listing every pane of the session. Returns a map
 * bookmarkKey -> { paneId, pid, command } where the visible right pane
 * (window 0, pane 1) is attributed to activeId.
 */
function getSessionPanes(activeId) {
  const out = tmuxQuiet([
    'list-panes', '-s', '-t', SESSION_NAME,
    '-F', '#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}'
  ]);
  const panes = new Map();
  let visiblePaneCount = 0;
  if (out === null) return { panes, visiblePaneCount: -1 };

  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [winIndex, winName, paneIndex, paneId, pid, command] = line.split('\t');
    const info = { paneId, pid: parseInt(pid, 10), command: command || '' };
    if (winIndex === '0') {
      visiblePaneCount++;
      if (paneIndex === '1' && activeId) panes.set(activeId, info);
    } else if (winName && winName.startsWith('_pane_') && paneIndex === '0') {
      panes.set(winName.slice('_pane_'.length), info);
    }
  }
  return { panes, visiblePaneCount };
}

/** Bookmark key of the session that owns a tmux pane id (e.g. "%3"), or null. */
function bookmarkKeyForPane(paneId) {
  const activeId = (tmuxQuiet(['show-options', '-t', SESSION_NAME, '-qv', '@active_bookmark_id']) || '').trim() || null;
  const { panes } = getSessionPanes(activeId);
  for (const [key, info] of panes) {
    if (info.paneId === paneId) return key;
  }
  return null;
}

function capturePane(paneId, lineCount = 30) {
  return tmuxQuiet(['capture-pane', '-p', '-t', paneId, '-S', `-${lineCount}`], { timeout: 1000 }) || '';
}

function procInfoFromPane(pane, agentNames) {
  if (!pane) return null;
  const comm = (pane.command || '').split('/').pop();
  return { pid: pane.pid, comm, isAgent: agentNames.has(comm) };
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

function parseGitStatus(output) {
  const lines = String(output || '').split('\n').filter(Boolean);
  let branch = '';
  if (lines[0] && lines[0].startsWith('## ')) {
    const head = lines.shift().slice(3);
    if (head.startsWith('No commits yet on ')) {
      branch = head.slice('No commits yet on '.length);
    } else if (head.startsWith('HEAD (no branch)')) {
      branch = 'detached';
    } else {
      branch = head.split('...')[0].split(' ')[0];
    }
  }
  const changedCount = lines.length;
  return {
    branch,
    isDirty: changedCount > 0,
    changedCount,
    summary: `${branch}${changedCount ? `* (${changedCount})` : ''}`
  };
}

/** Asynchronous git status; calls back with null if not a repo. */
function getGitInfoAsync(dirPath, callback) {
  if (!dirPath || !fs.existsSync(path.join(dirPath, '.git'))) {
    callback(null);
    return;
  }
  execFile(
    'git',
    ['-C', dirPath, 'status', '--porcelain', '-b'],
    { encoding: 'utf-8', timeout: 2000 },
    (err, stdout) => callback(err ? null : parseGitStatus(stdout))
  );
}

// ---------------------------------------------------------------------------
// Output heuristics (fallback when no hooks are configured)
// ---------------------------------------------------------------------------

function detectTerminalStatus(paneOutput, procInfo) {
  if (!paneOutput) return STATUS_TYPES.IDLE;

  const lines = stripAnsi(paneOutput).split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return STATUS_TYPES.IDLE;

  const recentLines = lines.slice(-6);
  const recentText = recentLines.join('\n');
  const fullRecent = lines.slice(-15).join('\n');
  const agentActive = Boolean(procInfo && procInfo.isAgent);

  // 1. Rate limit / quota
  if (/rate limit reached|quota exceeded|too many requests|usage limit reached|please wait \d+s/i.test(fullRecent)) {
    return STATUS_TYPES.RATE_LIMIT;
  }

  // 2. Blocking confirmation prompt on the last lines
  // Claude Code permission dialogs end with a numbered "1. Yes / 2. ... No" menu.
  const promptWindow = lines.slice(-10).join('\n');
  if (/^\s*[❯>]?\s*1\.\s*Yes\b/m.test(promptWindow) && /^\s*[❯>]?\s*[23]\.\s*(Yes|No)\b/m.test(promptWindow)) {
    return STATUS_TYPES.INPUT_REQUIRED;
  }
  const isActionRequired = recentLines.some(line =>
    /^\s*\?\s+(allow|approve|do you want|would you like|execute|run|confirm|select|proceed)/i.test(line) ||
    /\((y\/n|yes\/no)\)\s*:?\s*$/i.test(line) ||
    /\[(y\/n|y\/N|Y\/n)\]\s*:?\s*$/.test(line) ||
    /waiting for (user|confirmation|approval)/i.test(line)
  );
  if (isActionRequired) return STATUS_TYPES.INPUT_REQUIRED;

  // 3. Agent actively working (Claude Code shows "esc to interrupt")
  if (agentActive && /esc to (interrupt|cancel)|thinking…|thinking\.\.\.|\(\d+s\s*·/i.test(recentText)) {
    return STATUS_TYPES.RUNNING;
  }

  // 4. Errors on the very last lines
  const errorPatterns = [
    /fatal:\s+/i,
    /command failed/i,
    /uncaught exception/i,
    /npm ERR!/,
    /Traceback \(most recent call last\):/,
    /build failed/i
  ];
  const tail = recentLines.slice(-3).join(' ');
  if (errorPatterns.some(p => p.test(tail))) return STATUS_TYPES.ERROR;

  // 5. Completion markers
  if (/·\s*done\b|done in \d+|completed successfully|task complete|\btotal cost:\s*\$/i.test(fullRecent)) {
    return STATUS_TYPES.DONE;
  }

  return STATUS_TYPES.IDLE;
}

module.exports = {
  MANUAL_STATUS_TTL_MS,
  STATUS_TYPES,
  statusById,
  statusBadge,
  getStatusFile,
  loadManualStatuses,
  saveManualStatus,
  clearManualStatus,
  getManualStatus,
  resolveStatus,
  getSessionPanes,
  bookmarkKeyForPane,
  capturePane,
  procInfoFromPane,
  parseGitStatus,
  getGitInfoAsync,
  detectTerminalStatus
};
