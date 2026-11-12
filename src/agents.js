const { commandExists } = require('./exec');

const DEFAULT_AGENTS = [
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    shortcut: 'c',
    description: 'Anthropic Claude Code CLI'
  },
  {
    id: 'copilot',
    name: 'Copilot CLI',
    command: 'copilot',
    shortcut: 'p',
    description: 'GitHub Copilot CLI'
  },
  {
    id: 'shell',
    name: 'Terminal Shell',
    command: '',
    shortcut: '',
    description: 'Standard interactive shell'
  }
];

// Keys used by the sidebar itself; agents cannot steal them.
const RESERVED_KEYS = new Set([
  'a', 'd', 'e', 'j', 'k', 'o', 'q', 'r', 's', 'w',
  ' ', '<', '>', '[', ']', '-', '+', '\t', '\r', '\n'
]);

/** First word of a command line (the executable to probe). */
function executableOf(command) {
  return String(command || '').trim().split(/\s+/)[0] || '';
}

/**
 * Merge default agents with user-defined ones from config.agents. User entries
 * override defaults with the same id. Invalid/reserved shortcuts are dropped.
 */
function getAgents(config = {}) {
  const byId = new Map(DEFAULT_AGENTS.map(a => [a.id, { ...a }]));
  const userAgents = Array.isArray(config.agents) ? config.agents : [];

  for (const ua of userAgents) {
    if (!ua || !ua.id) continue;
    const base = byId.get(ua.id) || { id: ua.id, name: ua.id, command: '', shortcut: '' };
    byId.set(ua.id, {
      ...base,
      ...ua,
      command: ua.command !== undefined ? String(ua.command) : (ua.cmd !== undefined ? String(ua.cmd) : base.command)
    });
  }

  const usedShortcuts = new Set();
  return [...byId.values()].map(agent => {
    let shortcut = String(agent.shortcut || '').toLowerCase();
    if (shortcut.length !== 1 || RESERVED_KEYS.has(shortcut) || usedShortcuts.has(shortcut)) {
      shortcut = '';
    }
    if (shortcut) usedShortcuts.add(shortcut);
    return { ...agent, shortcut };
  });
}

function getAgentsWithStatus(config = {}) {
  return getAgents(config).map(agent => {
    const exe = executableOf(agent.command);
    return {
      ...agent,
      cmd: agent.command,
      installed: exe ? commandExists(exe) : true
    };
  });
}

function resolveAgent(agentId, config = {}) {
  const agents = getAgentsWithStatus(config);
  return agents.find(a => a.id === agentId) || null;
}

/** Process names that identify an agent running in the foreground. */
function getAgentProcessNames(config = {}) {
  const names = new Set(['claude', 'copilot', 'gemini', 'codex', 'aider', 'opencode', 'node']);
  for (const agent of getAgents(config)) {
    const exe = executableOf(agent.command);
    if (exe) names.add(exe.split('/').pop());
  }
  return names;
}

module.exports = {
  DEFAULT_AGENTS,
  RESERVED_KEYS,
  executableOf,
  getAgents,
  getAgentsWithStatus,
  resolveAgent,
  getAgentProcessNames,
  isCommandAvailable: commandExists
};
