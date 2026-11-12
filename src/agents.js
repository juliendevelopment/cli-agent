const { execSync } = require('child_process');

function isCommandAvailable(cmd) {
  try {
    execSync(`which ${cmd} 2>/dev/null`, { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

const DEFAULT_AGENTS = [
  {
    id: 'claude',
    name: 'Claude Code',
    cmd: 'claude',
    testCmd: 'claude',
    shortcut: 'c',
    description: 'Anthropic Claude Code CLI'
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    cmd: 'copilot',
    testCmd: 'copilot',
    shortcut: 'p',
    description: 'GitHub Copilot CLI'
  },
  {
    id: 'shell',
    name: 'Terminal Shell',
    cmd: '',
    testCmd: null,
    shortcut: 's',
    description: 'Standard interactive shell'
  }
];

function getAgentsWithStatus() {
  return DEFAULT_AGENTS.map(agent => {
    let installed = true;
    let effectiveCmd = agent.cmd;

    if (agent.id === 'copilot') {
      if (isCommandAvailable('copilot')) {
        installed = true;
        effectiveCmd = 'copilot';
      } else if (isCommandAvailable('gh')) {
        // gh extension copilot
        installed = true;
        effectiveCmd = 'gh copilot';
      } else {
        installed = false;
      }
    } else if (agent.testCmd) {
      installed = isCommandAvailable(agent.testCmd);
    }

    return {
      ...agent,
      cmd: effectiveCmd,
      installed
    };
  });
}

function resolveAgent(agentId) {
  const agents = getAgentsWithStatus();
  return agents.find(a => a.id === agentId) || agents[0];
}

module.exports = {
  DEFAULT_AGENTS,
  getAgentsWithStatus,
  resolveAgent,
  isCommandAvailable
};
