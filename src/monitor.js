const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { stripAnsi, colors } = require('./ui');

const STATUS_CONFIG_FILE = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'cli-agent',
  'statuses.json'
);

const STATUS_TYPES = {
  INPUT_REQUIRED: {
    id: 'input_required',
    label: 'Action Required',
    icon: '🔔',
    ansiColor: colors.brightYellow,
    bgBadge: '\x1b[43;30m' // black on yellow
  },
  RUNNING: {
    id: 'running',
    label: 'Running...',
    icon: '⚡',
    ansiColor: colors.brightCyan,
    bgBadge: '\x1b[46;30m' // black on cyan
  },
  DONE: {
    id: 'done',
    label: 'Done',
    icon: '✓',
    ansiColor: colors.brightGreen,
    bgBadge: '\x1b[42;30m' // black on green
  },
  ERROR: {
    id: 'error',
    label: 'Error',
    icon: '✗',
    ansiColor: colors.brightRed,
    bgBadge: '\x1b[41;37m' // white on red
  },
  RATE_LIMIT: {
    id: 'rate_limit',
    label: 'Rate Limit',
    icon: '⏳',
    ansiColor: colors.brightMagenta,
    bgBadge: '\x1b[45;37m' // white on magenta
  },
  IDLE: {
    id: 'idle',
    label: 'Idle',
    icon: '●',
    ansiColor: colors.gray,
    bgBadge: ''
  }
};

function loadManualStatuses() {
  try {
    if (fs.existsSync(STATUS_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(STATUS_CONFIG_FILE, 'utf-8'));
    }
  } catch (err) {
    // Ignore read error
  }
  return {};
}

function saveManualStatus(bookmarkIdOrName, statusKey, message = '') {
  const dir = path.dirname(STATUS_CONFIG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const current = loadManualStatuses();
  current[bookmarkIdOrName] = {
    status: statusKey,
    message,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(STATUS_CONFIG_FILE, JSON.stringify(current, null, 2), 'utf-8');
}

function getGitInfo(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return null;
  const gitDir = path.join(dirPath, '.git');
  if (!fs.existsSync(gitDir)) return null;

  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD 2>/dev/null', {
      cwd: dirPath,
      encoding: 'utf-8',
      timeout: 300
    }).trim();

    const statusOutput = execSync('git status --porcelain 2>/dev/null', {
      cwd: dirPath,
      encoding: 'utf-8',
      timeout: 300
    }).trim();

    const changedCount = statusOutput ? statusOutput.split('\n').filter(Boolean).length : 0;
    const isDirty = changedCount > 0;

    return {
      branch,
      isDirty,
      changedCount,
      summary: `${branch}${isDirty ? `* (${changedCount})` : ''}`
    };
  } catch (err) {
    return null;
  }
}

function getPaneOutput(targetPane = 'cli_agent:0.1', lineCount = 35) {
  try {
    return execSync(`tmux capture-pane -t ${targetPane} -p -S -${lineCount} 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 400
    });
  } catch (err) {
    return '';
  }
}

function getPaneProcess(targetPane = 'cli_agent:0.1') {
  try {
    const pidStr = execSync(`tmux display-message -t ${targetPane} -p '#{pane_pid}' 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 300
    }).trim();

    if (!pidStr) return null;
    const pid = parseInt(pidStr, 10);

    // Look for child process under shell
    const childStr = execSync(`pgrep -P ${pid} 2>/dev/null | tail -n 1`, {
      encoding: 'utf-8',
      timeout: 300
    }).trim();

    const targetPid = childStr ? parseInt(childStr, 10) : pid;
    const comm = execSync(`ps -o comm= -p ${targetPid} 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 300
    }).trim();

    return {
      pid: targetPid,
      comm: comm || 'shell',
      isAgent: ['claude', 'copilot', 'node', 'python', 'python3'].includes(comm)
    };
  } catch (err) {
    return null;
  }
}

function detectTerminalStatus(paneOutput, procInfo) {
  if (!paneOutput) {
    return STATUS_TYPES.IDLE;
  }

  const clean = stripAnsi(paneOutput);
  const lines = clean.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return STATUS_TYPES.IDLE;

  const recentLines = lines.slice(-5);
  const recentBottomText = recentLines.join('\n');
  const fullRecent = lines.slice(-15).join('\n');

  // 1. Check for Rate Limit / Quota warnings
  if (
    /rate limit reached|quota exceeded|too many requests|please wait \d+s/i.test(fullRecent)
  ) {
    return STATUS_TYPES.RATE_LIMIT;
  }

  // 2. Real confirmation prompt waiting on the active bottom lines
  const isActionRequired = recentLines.some(line => {
    // Check if line starts with question prompt or ends with (y/n)
    if (/^\s*\?\s+(allow|approve|do you want|would you like|execute|run|confirm|select|proceed)/i.test(line)) return true;
    if (/\((y\/n|yes\/no)\)\s*$/i.test(line) || /\[(y\/n|y\/N|Y\/n)\]\s*$/i.test(line)) return true;
    if (/waiting for (user|confirmation|approval|input)/i.test(line)) return true;
    return false;
  });

  if (isActionRequired) {
    return STATUS_TYPES.INPUT_REQUIRED;
  }

  // 3. Task Completion (Claude Code "· done 9:12 PM", "done in 2s", "Task complete", etc.)
  if (
    /·\s*done\b|done\s+\d+:\d+|done in \d+|completed successfully|task complete|\bcost:\s*\$|\btokens:\s*\d+/i.test(fullRecent)
  ) {
    return STATUS_TYPES.DONE;
  }

  // 4. Errors in recent lines
  const errorPatterns = [
    /fatal:\s+/i,
    /command failed/i,
    /uncaught exception/i,
    /npm ERR!/i,
    /Traceback \(most recent call last\):/i,
    /build failed/i
  ];

  for (const pat of errorPatterns) {
    if (pat.test(recentLines.slice(-3).join(' '))) {
      return STATUS_TYPES.ERROR;
    }
  }

  // 5. Active running agent (Claude Code / Copilot actively thinking or executing)
  if (procInfo && procInfo.isAgent) {
    if (/thinking\.\.\.|saut[ée]ing|cooking|brewing|generating|executing|searching|reading|editing/i.test(recentBottomText)) {
      return STATUS_TYPES.RUNNING;
    }
  }

  return STATUS_TYPES.IDLE;
}

function getPaneOutputForBookmark(bookmarkId, activeId, lineCount = 35) {
  const target = (bookmarkId === activeId)
    ? 'cli_agent:0.1'
    : `cli_agent:_pane_${bookmarkId}.0`;
  return getPaneOutput(target, lineCount);
}

function getPaneProcessForBookmark(bookmarkId, activeId) {
  const target = (bookmarkId === activeId)
    ? 'cli_agent:0.1'
    : `cli_agent:_pane_${bookmarkId}.0`;
  return getPaneProcess(target);
}

module.exports = {
  STATUS_TYPES,
  loadManualStatuses,
  saveManualStatus,
  getGitInfo,
  getPaneOutput,
  getPaneProcess,
  getPaneOutputForBookmark,
  getPaneProcessForBookmark,
  detectTerminalStatus
};
