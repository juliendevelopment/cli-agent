const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Dedicated tmux server socket: keeps CLI-Agent key bindings, mouse and
// clipboard settings isolated from the user's own tmux sessions.
const SOCKET = process.env.CLI_AGENT_SOCKET || 'cli-agent';
const SESSION_NAME = 'cli_agent';

function tmuxArgs(args) {
  return ['-L', SOCKET, ...args.map(String)];
}

/** Run a tmux command without a shell. Throws on failure. */
function tmux(args, opts = {}) {
  return execFileSync('tmux', tmuxArgs(args), {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 3000,
    ...opts
  });
}

/** Run a tmux command, returning its output or null on failure. */
function tmuxQuiet(args, opts) {
  try {
    return tmux(args, opts);
  } catch (err) {
    return null;
  }
}

/** Run an interactive tmux command (attach) bound to the current terminal. */
function tmuxInteractive(args, env = process.env) {
  return spawnSync('tmux', tmuxArgs(args), { stdio: 'inherit', env });
}

/** Quote a string for POSIX sh. */
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Look up an executable in PATH (no dependency on `which`). */
function commandExists(cmd) {
  if (!cmd) return false;
  if (cmd.includes('/')) {
    try {
      fs.accessSync(cmd, fs.constants.X_OK);
      return true;
    } catch (err) {
      return false;
    }
  }
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return true;
    } catch (err) {
      // not here
    }
  }
  return false;
}

module.exports = {
  SOCKET,
  SESSION_NAME,
  tmux,
  tmuxQuiet,
  tmuxInteractive,
  shQuote,
  commandExists
};
