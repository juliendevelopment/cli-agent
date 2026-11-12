/**
 * Status integrations: make each AI agent report its own status to CLI-Agent
 * (instead of guessing it from the terminal output).
 *
 * Every integration ends up running `cli-agent notify --hook <status>`:
 *   running  the agent is working
 *   input    the agent waits for a permission / an answer
 *   done     the agent finished its turn
 *
 * Formats (verified against each tool):
 *   Claude Code  ~/.claude/settings.json           { hooks: { Event: [{ matcher, hooks: [{ type, command }] }] } }
 *   Codex        ~/.codex/hooks.json                same shape as Claude Code (hooks must be trusted with /hooks)
 *   Copilot CLI  ~/.copilot/hooks/cli-agent.json    { version: 1, hooks: { event: [{ type, bash, timeoutSec }] } }
 *   Antigravity  ~/.gemini/config/hooks.json        { "<group>": { enabled, Event: [...] } } (no permission event)
 *   OpenCode     ~/.config/opencode/plugins/cli-agent.js   server plugin subscribed to the event bus
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { commandExists, resolveCommand, shQuote } = require('./exec');
const { writeJsonAtomic } = require('./config');

const ENTRYPOINT = path.resolve(__dirname, '..', 'bin', 'cli-agent.js');
const HOOK_TIMEOUT_S = 10;
const AGY_GROUP = 'cli-agent';

function realpathOrNull(file) {
  try {
    return fs.realpathSync(file);
  } catch (err) {
    return null;
  }
}

/**
 * argv used to call cli-agent from a hook: always the copy that installed the
 * hooks. The short `cli-agent` name is used only when it resolves to that copy
 * (survives Node upgrades); a dev checkout gets absolute paths.
 */
function notifyArgv() {
  const inPath = resolveCommand('cli-agent');
  if (inPath && realpathOrNull(inPath) === realpathOrNull(ENTRYPOINT)) return ['cli-agent'];
  return [process.execPath, ENTRYPOINT];
}

function hookCommand(status) {
  return `${notifyArgv().map(a => (a === 'cli-agent' ? a : shQuote(a))).join(' ')} notify --hook ${status}`;
}

/** True for a hook command written by CLI-Agent (any version). */
function isOurCommand(command) {
  return typeof command === 'string' && /cli-agent(\.js)?'?\s+notify\b/.test(command);
}

/** True for a Claude/Codex style matcher group containing one of our hooks. */
function isOurHook(group) {
  return Array.isArray(group && group.hooks) && group.hooks.some(h => h && isOurCommand(h.command));
}

function home(...parts) {
  return path.join(os.homedir(), ...parts);
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf-8');
  if (!raw.trim()) return {};
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch (err) {
    // fall through
  }
  throw new Error(`${file} is not valid JSON; not modifying it`);
}

/** Write a JSON file the user may also edit, keeping a one-time backup. */
function writeSharedJson(file, data) {
  if (fs.existsSync(file)) {
    const backup = `${file}.cli-agent.bak`;
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  }
  writeJsonAtomic(file, data);
}

// ---------------------------------------------------------------------------
// Claude Code / Codex (same hooks shape)
// ---------------------------------------------------------------------------

function nestedHooks(events) {
  const out = {};
  for (const [event, { status, matcher }] of Object.entries(events)) {
    const group = { hooks: [{ type: 'command', command: hookCommand(status), timeout: HOOK_TIMEOUT_S }] };
    if (matcher) group.matcher = matcher;
    out[event] = [group];
  }
  return out;
}

function nestedIntegration({ id, name, file, binary, configDir, events, note }) {
  const filterOurs = groups => (Array.isArray(groups) ? groups.filter(g => !isOurHook(g)) : []);
  return {
    id,
    name,
    file,
    note,
    detect: () => commandExists(binary) || fs.existsSync(configDir()),
    build: () => nestedHooks(events),
    isInstalled() {
      try {
        const hooks = readJson(file()).hooks || {};
        return Object.values(hooks).some(groups => Array.isArray(groups) && groups.some(isOurHook));
      } catch (err) {
        return false;
      }
    },
    install() {
      const data = readJson(file());
      data.hooks = data.hooks && typeof data.hooks === 'object' ? data.hooks : {};
      for (const [event, groups] of Object.entries(this.build())) {
        data.hooks[event] = [...filterOurs(data.hooks[event]), ...groups];
      }
      writeSharedJson(file(), data);
    },
    uninstall() {
      if (!fs.existsSync(file())) return false;
      const data = readJson(file());
      if (!data.hooks) return false;
      let changed = false;
      for (const event of Object.keys(data.hooks)) {
        const kept = filterOurs(data.hooks[event]);
        if (!Array.isArray(data.hooks[event]) || kept.length === data.hooks[event].length) continue;
        changed = true;
        if (kept.length) data.hooks[event] = kept;
        else delete data.hooks[event];
      }
      if (changed) writeSharedJson(file(), data);
      return changed;
    }
  };
}

const claude = nestedIntegration({
  id: 'claude',
  name: 'Claude Code',
  binary: 'claude',
  configDir: () => home('.claude'),
  file: () => home('.claude', 'settings.json'),
  note: 'Restart running Claude Code sessions to load the hooks.',
  events: {
    UserPromptSubmit: { status: 'running' },
    PostToolUse: { status: 'running', matcher: '*' },
    // Only real blocking prompts (not the "idle for 60s" reminder)
    Notification: { status: 'input', matcher: 'permission_prompt|elicitation_dialog' },
    Stop: { status: 'done' }
  }
});

const codex = nestedIntegration({
  id: 'codex',
  name: 'Codex',
  binary: 'codex',
  configDir: () => process.env.CODEX_HOME || home('.codex'),
  file: () => path.join(process.env.CODEX_HOME || home('.codex'), 'hooks.json'),
  note: 'In Codex, run /hooks once to review and trust the new hooks (untrusted hooks are skipped).',
  events: {
    UserPromptSubmit: { status: 'running' },
    PostToolUse: { status: 'running', matcher: '*' },
    PermissionRequest: { status: 'input', matcher: '*' },
    Stop: { status: 'done' }
  }
});

// ---------------------------------------------------------------------------
// GitHub Copilot CLI: a dedicated file in ~/.copilot/hooks/
// ---------------------------------------------------------------------------

function copilotDir() {
  return process.env.COPILOT_HOME || home('.copilot');
}

const copilot = {
  id: 'copilot',
  name: 'Copilot CLI',
  file: () => path.join(copilotDir(), 'hooks', 'cli-agent.json'),
  note: 'Restart running Copilot CLI sessions to load the hooks.',
  detect: () => commandExists('copilot') || fs.existsSync(copilotDir()),
  build() {
    const entry = status => [{ type: 'command', bash: hookCommand(status), timeoutSec: HOOK_TIMEOUT_S }];
    return {
      version: 1,
      hooks: {
        userPromptSubmitted: entry('running'),
        postToolUse: entry('running'),
        permissionRequest: entry('input'),
        agentStop: entry('done')
      }
    };
  },
  isInstalled() {
    return fs.existsSync(this.file());
  },
  install() {
    writeJsonAtomic(this.file(), this.build());
  },
  uninstall() {
    if (!fs.existsSync(this.file())) return false;
    fs.rmSync(this.file());
    return true;
  }
};

// ---------------------------------------------------------------------------
// Antigravity CLI (agy): a named group in ~/.gemini/config/hooks.json
// Notes: hooks run from ~/.gemini/config (the project comes from the JSON on
// stdin), there is no permission event, and PreToolUse must not be used: an
// answer without a decision denies the tool.
// ---------------------------------------------------------------------------

const agy = {
  id: 'agy',
  name: 'Antigravity CLI',
  file: () => home('.gemini', 'config', 'hooks.json'),
  note: 'Restart running agy sessions to load the hooks. Agy has no permission event: "Action required" still comes from the terminal output.',
  detect: () => commandExists('agy') || fs.existsSync(home('.gemini', 'antigravity-cli')),
  build() {
    const entry = status => ({ type: 'command', command: hookCommand(status), timeout: HOOK_TIMEOUT_S });
    return {
      enabled: true,
      PreInvocation: [entry('running')],
      PostToolUse: [{ matcher: '*', hooks: [entry('running')] }],
      Stop: [entry('done')]
    };
  },
  isInstalled() {
    try {
      return Boolean(readJson(this.file())[AGY_GROUP]);
    } catch (err) {
      return false;
    }
  },
  install() {
    const data = readJson(this.file());
    data[AGY_GROUP] = this.build();
    writeSharedJson(this.file(), data);
  },
  uninstall() {
    if (!fs.existsSync(this.file())) return false;
    const data = readJson(this.file());
    if (!(AGY_GROUP in data)) return false;
    delete data[AGY_GROUP];
    if (Object.keys(data).length === 0) fs.rmSync(this.file());
    else writeSharedJson(this.file(), data);
    return true;
  }
};

// ---------------------------------------------------------------------------
// OpenCode: a server plugin. It runs inside the shared `opencode serve`
// process (not in the tmux pane), so it reports the session's directory.
// ---------------------------------------------------------------------------

function opencodeDir() {
  return path.join(process.env.XDG_CONFIG_HOME || home('.config'), 'opencode');
}

function opencodePlugin() {
  return `// Generated by CLI-Agent (cli-agent hooks --install). Do not edit: re-run the command instead.
// Reports OpenCode activity to the CLI-Agent sidebar.
import { Plugin } from "@opencode/plugin"
import { spawn } from "node:child_process"

const NOTIFY = ${JSON.stringify(notifyArgv())}
const STATUS = {
  "session.execution.started": "running",
  "permission.asked": "input",
  "permission.replied": "running",
  "session.execution.succeeded": "done",
  "session.execution.failed": "error",
  "session.execution.interrupted": "clear",
}
// Shared by every plugin instance of this process
const state = (globalThis.__cliAgentNotify ??= { seen: new Set(), dirs: new Map() })

function notify(dir, status) {
  try {
    const child = spawn(NOTIFY[0], [...NOTIFY.slice(1), "notify", "--quiet", dir, status], {
      stdio: "ignore",
      detached: true,
    })
    child.on("error", () => {})
    child.unref()
  } catch {}
}

export default Plugin.define({
  id: "cli-agent",
  async setup(ctx) {
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const sessionID = event.data?.sessionID ?? event.durable?.aggregateID
          const dir = event.location?.directory
          if (sessionID && dir) state.dirs.set(sessionID, dir)
          const status = STATUS[event.type]
          if (!status || state.seen.has(event.id)) continue
          state.seen.add(event.id)
          if (state.seen.size > 1000) state.seen.clear()
          const target = dir ?? state.dirs.get(sessionID)
          if (target) notify(target, status)
        }
      } catch {}
    })()
    return () => controller.abort()
  },
})
`;
}

const opencode = {
  id: 'opencode',
  name: 'OpenCode',
  file: () => path.join(opencodeDir(), 'plugins', 'cli-agent.js'),
  note: 'Restart OpenCode (including its background service) to load the plugin.',
  detect: () => commandExists('opencode') || fs.existsSync(opencodeDir()),
  build: opencodePlugin,
  isInstalled() {
    return fs.existsSync(this.file());
  },
  install() {
    fs.mkdirSync(path.dirname(this.file()), { recursive: true });
    fs.writeFileSync(this.file(), this.build(), 'utf-8');
  },
  uninstall() {
    if (!fs.existsSync(this.file())) return false;
    fs.rmSync(this.file());
    return true;
  }
};

const INTEGRATIONS = [claude, codex, copilot, agy, opencode];

function getIntegration(id) {
  return INTEGRATIONS.find(i => i.id === id) || null;
}

module.exports = {
  INTEGRATIONS,
  getIntegration,
  hookCommand,
  isOurCommand,
  isOurHook,
  opencodePlugin
};
