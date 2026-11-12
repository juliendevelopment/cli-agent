const { execSync, spawnSync } = require('child_process');
const path = require('path');

const SESSION_NAME = 'cli_agent';
const DEFAULT_SIDEBAR_WIDTH = 26;

let activeBookmarkId = null;

function isTmuxInstalled() {
  try {
    execSync('which tmux 2>/dev/null', { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

function isInsideTmux() {
  return Boolean(process.env.TMUX);
}

function sessionExists(session = SESSION_NAME) {
  try {
    execSync(`tmux has-session -t ${session} 2>/dev/null`, { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

function runTmux(args) {
  return spawnSync('tmux', args, { stdio: 'inherit' });
}

function runTmuxQuiet(args) {
  try {
    return execSync(`tmux ${args.join(' ')} 2>/dev/null`, { encoding: 'utf-8' });
  } catch (err) {
    return null;
  }
}

function getActiveBookmarkId() {
  return activeBookmarkId;
}

function setActiveBookmarkId(id) {
  activeBookmarkId = id;
}

function hasBookmarkWindow(bookmarkId) {
  try {
    const list = execSync(`tmux list-windows -t ${SESSION_NAME} -F '#{window_name}' 2>/dev/null`, {
      encoding: 'utf-8'
    });
    const targetName = `_pane_${bookmarkId}`;
    return list.split('\n').map(s => s.trim()).includes(targetName);
  } catch (err) {
    return false;
  }
}

function switchToBookmark(targetBookmark, agentCommand = '', focus = true) {
  if (!targetBookmark) return;
  const targetId = targetBookmark.id || targetBookmark.name;
  const currentId = activeBookmarkId;
  const shellCmd = process.env.SHELL || '/bin/bash';

  // If already visible in the right pane:
  if (targetId === currentId) {
    if (agentCommand && agentCommand.trim()) {
      execSync(`tmux send-keys -t ${SESSION_NAME}:0.1 '${agentCommand.trim()}' C-m`, { stdio: 'ignore' });
    }
    if (focus) focusPane(1);
    return;
  }

  // If we are switching from another bookmark:
  if (currentId) {
    // 1. Ensure the target bookmark's window exists or create it
    if (!hasBookmarkWindow(targetId)) {
      // First time opening this bookmark: create independent background window
      execSync(
        `tmux new-window -d -t ${SESSION_NAME} -n "_pane_${targetId}" -c "${targetBookmark.path}" "${shellCmd}"`,
        { stdio: 'ignore' }
      );
      if (agentCommand && agentCommand.trim()) {
        execSync(
          `tmux send-keys -t ${SESSION_NAME}:_pane_${targetId}.0 '${agentCommand.trim()}' C-m`,
          { stdio: 'ignore' }
        );
      }
    } else if (agentCommand && agentCommand.trim()) {
      // Already existed, send requested command
      execSync(
        `tmux send-keys -t ${SESSION_NAME}:_pane_${targetId}.0 '${agentCommand.trim()}' C-m`,
        { stdio: 'ignore' }
      );
    }

    // 2. Swap visible right pane (0.1) with background window _pane_${targetId}.0
    execSync(`tmux swap-pane -s ${SESSION_NAME}:0.1 -t ${SESSION_NAME}:_pane_${targetId}.0`, { stdio: 'ignore' });

    // 3. Rename the background window (which now holds currentId's pane)
    execSync(`tmux rename-window -t ${SESSION_NAME}:_pane_${targetId} "_pane_${currentId}"`, { stdio: 'ignore' });
  } else {
    // Initial launch (targetId becomes the active one in pane 0.1)
    if (agentCommand && agentCommand.trim()) {
      execSync(`tmux send-keys -t ${SESSION_NAME}:0.1 '${agentCommand.trim()}' C-m`, { stdio: 'ignore' });
    }
  }

  activeBookmarkId = targetId;

  if (focus) {
    focusPane(1);
  }
}

function closeBookmarkSession(bookmarkId) {
  try {
    if (hasBookmarkWindow(bookmarkId)) {
      execSync(`tmux kill-window -t ${SESSION_NAME}:_pane_${bookmarkId}`, { stdio: 'ignore' });
    }
  } catch (err) {
    // Ignore
  }
}

function resizeSidebar(delta) {
  try {
    const dir = delta < 0 ? 'L' : 'R';
    const amount = Math.abs(delta);
    execSync(`tmux resize-pane -t ${SESSION_NAME}:0.0 -${dir} ${amount}`, { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

function setSidebarWidth(width) {
  try {
    execSync(`tmux resize-pane -t ${SESSION_NAME}:0.0 -x ${width}`, { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

function focusPane(paneIndex = 0) {
  try {
    execSync(`tmux select-pane -t ${SESSION_NAME}:0.${paneIndex}`, { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

function killSession(session = SESSION_NAME) {
  try {
    execSync(`tmux kill-session -t ${session} 2>/dev/null`, { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

function startWorkspace({ initialBookmark, scriptPath, initialWidth = DEFAULT_SIDEBAR_WIDTH }) {
  if (!isTmuxInstalled()) {
    console.error('Error: tmux is not installed on this system.');
    console.error('Please install tmux (e.g. sudo apt install tmux or sudo dnf install tmux).');
    process.exit(1);
  }

  const shellCmd = process.env.SHELL || '/bin/bash';
  const nodeBin = process.execPath;
  const sidebarScript = path.resolve(scriptPath);

  // If session already exists, attach to it
  if (sessionExists(SESSION_NAME)) {
    console.log(`Attaching to existing '${SESSION_NAME}' session...`);
    runTmux(['attach-session', '-t', SESSION_NAME]);
    return;
  }

  const sidebarCmd = `${nodeBin} "${sidebarScript}" --sidebar`;
  const initialDir = initialBookmark ? initialBookmark.path : process.cwd();
  const initialId = initialBookmark ? (initialBookmark.id || initialBookmark.name) : 'default';

  // 1. Create detached session running sidebar in pane 0
  execSync(`tmux new-session -d -s ${SESSION_NAME} -n "CLI-Agent" '${sidebarCmd}'`);

  // 2. Split horizontally: pane 1 on the right running shell in initialDir
  execSync(`tmux split-window -h -t ${SESSION_NAME}:0.0 -c "${initialDir}" "${shellCmd}"`);

  // 3. Set sidebar width (compact by default: e.g. 26 columns)
  execSync(`tmux resize-pane -t ${SESSION_NAME}:0.0 -x ${initialWidth}`);

  // 4. Configure mouse, borders, and status line
  execSync(`tmux set-option -t ${SESSION_NAME} mouse on`);
  execSync(`tmux set-option -t ${SESSION_NAME} status on`);
  execSync(`tmux set-option -t ${SESSION_NAME} status-style "bg=#1e1e2e,fg=#cdd6f4"`);
  execSync(`tmux set-option -t ${SESSION_NAME} status-left "#[bold,fg=#89b4fa] 🤖 CLI-AGENT #[default]│ "`);
  execSync(`tmux set-option -t ${SESSION_NAME} status-left-length 30`);
  execSync(
    `tmux set-option -t ${SESSION_NAME} status-right "#[fg=#a6adc8]Tab: Terminal │ Alt+←: Menu │ M-[: Shrink │ M-]: Grow #[default]"`
  );
  execSync(`tmux set-option -t ${SESSION_NAME} pane-border-style "fg=#313244"`);
  execSync(`tmux set-option -t ${SESSION_NAME} pane-active-border-style "fg=#89b4fa"`);

  // 5. Quick navigation & resize bindings
  execSync(`tmux bind-key -n M-Left select-pane -t ${SESSION_NAME}:0.0`);
  execSync(`tmux bind-key -n M-Right select-pane -t ${SESSION_NAME}:0.1`);
  execSync(`tmux bind-key -n F1 select-pane -t ${SESSION_NAME}:0.0`);
  execSync(`tmux bind-key -n F2 select-pane -t ${SESSION_NAME}:0.1`);
  execSync(`tmux bind-key -n M-[ resize-pane -t ${SESSION_NAME}:0.0 -L 3`);
  execSync(`tmux bind-key -n M-] resize-pane -t ${SESSION_NAME}:0.0 -R 3`);

  // 6. Select sidebar pane initially
  execSync(`tmux select-pane -t ${SESSION_NAME}:0.0`);

  // 7. Record initial active bookmark ID
  setActiveBookmarkId(initialId);

  // 8. Attach session
  runTmux(['attach-session', '-t', SESSION_NAME]);
}

module.exports = {
  SESSION_NAME,
  DEFAULT_SIDEBAR_WIDTH,
  isTmuxInstalled,
  isInsideTmux,
  sessionExists,
  getActiveBookmarkId,
  setActiveBookmarkId,
  hasBookmarkWindow,
  switchToBookmark,
  closeBookmarkSession,
  resizeSidebar,
  setSidebarWidth,
  focusPane,
  killSession,
  startWorkspace
};
