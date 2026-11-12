const { execSync, spawnSync } = require('child_process');
const path = require('path');

const SESSION_NAME = 'cli_agent';

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

function sendToTerminalPane(targetDir, command = '', focus = true) {
  try {
    // Pane 1 is the right terminal pane
    const target = `${SESSION_NAME}:0.1`;

    // Cancel any running input line
    execSync(`tmux send-keys -t ${target} C-c`, { stdio: 'ignore' });

    let script = `cd "${targetDir}" && clear`;
    if (command && command.trim().length > 0) {
      script += ` && ${command.trim()}`;
    }

    execSync(`tmux send-keys -t ${target} '${script}' C-m`, { stdio: 'ignore' });

    if (focus) {
      execSync(`tmux select-pane -t ${target}`, { stdio: 'ignore' });
    }
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

function startWorkspace({ initialDir, scriptPath }) {
  if (!isTmuxInstalled()) {
    console.error('Erreur: tmux n\'est pas installé sur ce système.');
    console.error('Installez tmux (ex: sudo dnf install tmux ou sudo apt install tmux).');
    process.exit(1);
  }

  const shellCmd = process.env.SHELL || '/bin/bash';
  const nodeBin = process.execPath;
  const sidebarScript = path.resolve(scriptPath);

  // If session already exists, attach to it
  if (sessionExists(SESSION_NAME)) {
    console.log(`Rattachement à la session existante '${SESSION_NAME}'...`);
    runTmux(['attach-session', '-t', SESSION_NAME]);
    return;
  }

  const sidebarCmd = `${nodeBin} "${sidebarScript}" --sidebar`;

  // 1. Create detached session running sidebar in pane 0
  execSync(`tmux new-session -d -s ${SESSION_NAME} -n "CLI-Agent" '${sidebarCmd}'`);

  // 2. Split horizontally: pane 1 on the right with ~70% width, running shell in initialDir
  execSync(`tmux split-window -h -t ${SESSION_NAME}:0.0 -p 72 -c "${initialDir}" "${shellCmd}"`);

  // 3. Configure mouse and UI
  execSync(`tmux set-option -t ${SESSION_NAME} mouse on`);
  execSync(`tmux set-option -t ${SESSION_NAME} status on`);
  execSync(`tmux set-option -t ${SESSION_NAME} status-style "bg=#1e1e2e,fg=#cdd6f4"`);
  execSync(`tmux set-option -t ${SESSION_NAME} status-left "#[bold,fg=#89b4fa] 🤖 CLI-AGENT #[default]│ "`);
  execSync(`tmux set-option -t ${SESSION_NAME} status-left-length 30`);
  execSync(`tmux set-option -t ${SESSION_NAME} status-right "#[fg=#a6adc8]Tab/Alt+→: Terminal │ Alt+←: Menu │ F1/F2 #[default]"`);
  execSync(`tmux set-option -t ${SESSION_NAME} pane-border-style "fg=#313244"`);
  execSync(`tmux set-option -t ${SESSION_NAME} pane-active-border-style "fg=#89b4fa"`);

  // 4. Quick navigation bindings between left and right panes
  execSync(`tmux bind-key -n M-Left select-pane -t ${SESSION_NAME}:0.0`);
  execSync(`tmux bind-key -n M-Right select-pane -t ${SESSION_NAME}:0.1`);
  execSync(`tmux bind-key -n F1 select-pane -t ${SESSION_NAME}:0.0`);
  execSync(`tmux bind-key -n F2 select-pane -t ${SESSION_NAME}:0.1`);

  // 5. Select sidebar pane initially
  execSync(`tmux select-pane -t ${SESSION_NAME}:0.0`);

  // 6. Attach session to terminal
  runTmux(['attach-session', '-t', SESSION_NAME]);
}

module.exports = {
  SESSION_NAME,
  isTmuxInstalled,
  isInsideTmux,
  sessionExists,
  sendToTerminalPane,
  focusPane,
  killSession,
  startWorkspace
};
