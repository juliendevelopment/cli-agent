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
  const recentLines = lines.slice(-15);
  const recentText = recentLines.join(' \n ');

  // 1. Check for Rate Limit
  if (
    /rate limit reached|quota exceeded|too many requests|please wait \d+s/i.test(recentText)
  ) {
    return STATUS_TYPES.RATE_LIMIT;
  }

  // 2. Check for Input Required / User Action
  const inputPatterns = [
    /\?\s+[A-Z]/,                         // Inquirer / Clack / Claude prompt (e.g. "? Allow bash to run")
    /\([yY]\/[nN]\)|\[[yY]\/[nN]\]/,      // (y/n) or [y/N]
    /waiting for (user|input)/i,
    /(allow|approve|confirm)\s+(tool|command|execution|action)/i,
    /do you want to (continue|proceed|run)/i,
    /type.*to confirm/i,
    /press enter to/i,
    /enter your (choice|prompt|input)/i,
    /select (one|an option)/i
  ];

  for (const pat of inputPatterns) {
    if (pat.test(recentText)) {
      return STATUS_TYPES.INPUT_REQUIRED;
    }
  }

  // 3. Check for Active Running Agent
  if (procInfo && procInfo.isAgent) {
    // If agent is active and running
    if (/thinking\.\.\.|generating|searching|running command|executing/i.test(recentText)) {
      return STATUS_TYPES.RUNNING;
    }
  }

  // 4. Check for Errors
  const errorPatterns = [
    /fatal:\s+/i,
    /command failed/i,
    /uncaught exception/i,
    /npm ERR!/i,
    /Traceback \(most recent call last\):/i,
    /build failed/i
  ];

  for (const pat of errorPatterns) {
    if (pat.test(recentLines.slice(-6).join(' '))) {
      return STATUS_TYPES.ERROR;
    }
  }

  // 5. Check for Task Completion
  if (
    /task complete|done in \d+|completed successfully|tokens:.*cost:/i.test(recentText)
  ) {
    return STATUS_TYPES.DONE;
  }

  if (procInfo && procInfo.isAgent) {
    return STATUS_TYPES.RUNNING;
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
