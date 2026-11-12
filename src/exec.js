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

/** Full path of an executable found in PATH, or null (no dependency on `which`). */
function resolveCommand(cmd) {
  if (!cmd) return null;
  const candidates = cmd.includes('/')
    ? [cmd]
    : (process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, cmd));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (err) {
      // not here
    }
  }
  return null;
}

function commandExists(cmd) {
  return resolveCommand(cmd) !== null;
}

module.exports = {
  SOCKET,
  SESSION_NAME,
  tmux,
  tmuxQuiet,
  tmuxInteractive,
  shQuote,
  resolveCommand,
  commandExists
};
