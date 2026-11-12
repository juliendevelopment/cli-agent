const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');

const { shQuote, commandExists } = require('../src/exec');
const { getAgents, RESERVED_KEYS } = require('../src/agents');
const { keyLabel } = require('../src/tmux');
const { buildHooks, isOurHook, STATUS_ALIASES } = require('../src/index');
const { stripAnsi } = require('../src/ui');

test('shQuote survives quotes, $ and backticks', () => {
  for (const value of ["it's", 'a "b" $HOME `id`', '']) {
    const out = execFileSync('sh', ['-c', `printf %s ${shQuote(value)}`], { encoding: 'utf-8' });
    assert.equal(out, value);
  }
});

test('commandExists finds sh and rejects unknown commands', () => {
  assert.equal(commandExists('sh'), true);
  assert.equal(commandExists('definitely-not-a-command-xyz'), false);
  assert.equal(commandExists(''), false);
});

test('getAgents merges user agents and protects reserved shortcuts', () => {
  const agents = getAgents({
    agents: [
      { id: 'gemini', name: 'Gemini CLI', command: 'gemini', shortcut: 'g' },
      { id: 'bad', command: 'bad', shortcut: 'q' }, // reserved
      { id: 'dup', command: 'dup', shortcut: 'c' }, // already used by claude
      { id: 'claude', command: 'claude --continue' } // override
    ]
  });
  const byId = Object.fromEntries(agents.map(a => [a.id, a]));
  assert.equal(byId.gemini.shortcut, 'g');
  assert.equal(byId.bad.shortcut, '');
  assert.equal(byId.dup.shortcut, '');
  assert.equal(byId.claude.command, 'claude --continue');
  assert.equal(byId.claude.shortcut, 'c');
  for (const a of agents) assert.ok(!RESERVED_KEYS.has(a.shortcut) || a.shortcut === '');
});

test('keyLabel renders tmux key names', () => {
  assert.equal(keyLabel('C-e'), 'Ctrl+E');
  assert.equal(keyLabel('M-k'), 'Alt+K');
  assert.equal(keyLabel('F5'), 'F5');
});

test('hooks: only blocking notifications, all recognised as ours', () => {
  const hooks = buildHooks();
  assert.deepEqual(Object.keys(hooks).sort(), ['Notification', 'PostToolUse', 'Stop', 'UserPromptSubmit']);
  assert.equal(hooks.Notification[0].matcher, 'permission_prompt|elicitation_dialog');
  for (const groups of Object.values(hooks)) {
    for (const group of groups) {
      assert.ok(isOurHook(group), JSON.stringify(group));
      assert.match(group.hooks[0].command, /notify --quiet "\$CLAUDE_PROJECT_DIR" /);
    }
  }
  assert.equal(isOurHook({ hooks: [{ type: 'command', command: 'echo hi' }] }), false);
});

test('every notify alias maps to a known status', () => {
  const known = new Set(['input_required', 'running', 'done', 'error', 'rate_limit', 'clear']);
  for (const v of Object.values(STATUS_ALIASES)) assert.ok(known.has(v), v);
});

test('stripAnsi removes color codes', () => {
  assert.equal(stripAnsi('\x1b[1;32mok\x1b[0m'), 'ok');
});
