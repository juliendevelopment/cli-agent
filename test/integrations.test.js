const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Fake home + config dir before loading the modules
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-agent-integ-'));
process.env.HOME = tmp;
process.env.XDG_CONFIG_HOME = path.join(tmp, '.config');
delete process.env.CODEX_HOME;
delete process.env.COPILOT_HOME;

const { INTEGRATIONS, getIntegration, isOurHook } = require('../src/integrations');

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf-8'));
const ENTRY = path.resolve(__dirname, '..', 'bin', 'cli-agent.js');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Make every agent "detected" through its config directory
for (const dir of ['.claude', '.codex', '.copilot', '.gemini/antigravity-cli', '.config/opencode']) {
  fs.mkdirSync(path.join(tmp, dir), { recursive: true });
}

test('every integration is detected and installs where expected', () => {
  for (const integ of INTEGRATIONS) {
    assert.ok(integ.detect(), integ.id);
    assert.equal(integ.isInstalled(), false, integ.id);
    integ.install();
    assert.ok(integ.isInstalled(), integ.id);
    assert.ok(integ.file().startsWith(tmp), integ.file());
  }
});

test('claude: keeps user hooks, is idempotent, uninstalls cleanly', () => {
  const claude = getIntegration('claude');
  const file = claude.file();
  const userGroup = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] };
  const data = readJson(file);
  data.theme = 'dark';
  data.hooks.PostToolUse.unshift(userGroup);
  fs.writeFileSync(file, JSON.stringify(data));

  claude.install();
  const after = readJson(file);
  assert.equal(after.theme, 'dark');
  assert.deepEqual(after.hooks.PostToolUse[0], userGroup);
  assert.equal(after.hooks.PostToolUse.filter(isOurHook).length, 1);
  assert.equal(after.hooks.Notification[0].matcher, 'permission_prompt|elicitation_dialog');
  assert.match(after.hooks.Stop[0].hooks[0].command, /notify --hook done$/);

  assert.equal(claude.uninstall(), true);
  const cleaned = readJson(file);
  assert.equal(cleaned.theme, 'dark');
  assert.deepEqual(cleaned.hooks, { PostToolUse: [userGroup] });
  assert.ok(fs.existsSync(`${file}.cli-agent.bak`));
});

test('claude: replaces hooks written by older versions', () => {
  const claude = getIntegration('claude');
  const old = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'cli-agent notify --quiet "$CLAUDE_PROJECT_DIR" done' }] }] } };
  fs.writeFileSync(claude.file(), JSON.stringify(old));
  claude.install();
  const stop = readJson(claude.file()).hooks.Stop;
  assert.equal(stop.length, 1);
  assert.match(stop[0].hooks[0].command, /--hook done/);
});

test('codex uses PermissionRequest for "input"', () => {
  const hooks = readJson(getIntegration('codex').file()).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ['PermissionRequest', 'PostToolUse', 'Stop', 'UserPromptSubmit']);
  assert.match(hooks.PermissionRequest[0].hooks[0].command, /--hook input$/);
});

test('copilot writes its own versioned file', () => {
  const data = readJson(getIntegration('copilot').file());
  assert.equal(data.version, 1);
  assert.deepEqual(Object.keys(data.hooks).sort(), ['agentStop', 'permissionRequest', 'postToolUse', 'userPromptSubmitted']);
  assert.match(data.hooks.agentStop[0].bash, /--hook done$/);
});

test('agy: named group, never PreToolUse, other groups kept', () => {
  const agy = getIntegration('agy');
  const data = readJson(agy.file());
  data.other = { enabled: true, Stop: [{ type: 'command', command: 'echo other' }] };
  fs.writeFileSync(agy.file(), JSON.stringify(data));
  agy.install();
  const after = readJson(agy.file());
  assert.ok(after.other);
  assert.equal('PreToolUse' in after['cli-agent'], false);
  assert.deepEqual(Object.keys(after['cli-agent']).sort(), ['PostToolUse', 'PreInvocation', 'Stop', 'enabled']);
  agy.uninstall();
  assert.deepEqual(Object.keys(readJson(agy.file())), ['other']);
});

test('opencode plugin maps the verified event names', () => {
  const src = fs.readFileSync(getIntegration('opencode').file(), 'utf-8');
  for (const ev of ['session.execution.started', 'permission.asked', 'permission.replied', 'session.execution.succeeded']) {
    assert.ok(src.includes(`"${ev}"`), ev);
  }
  assert.match(src, /Plugin\.define/);
});

test('notify --hook finds the bookmark from the payload cwd', () => {
  const project = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  const env = { ...process.env, TMUX: '', TMUX_PANE: '' };
  const run = (args, input) => spawnSync(process.execPath, [ENTRY, ...args], { env, input, encoding: 'utf-8', cwd: tmp });

  assert.equal(run(['add', 'Proj', project]).status, 0);
  const statuses = () => readJson(path.join(tmp, '.config', 'cli-agent', 'statuses.json'));

  // agy runs hooks from ~/.gemini/config: the project comes from the payload
  const r = run(['notify', '--hook', 'running'], JSON.stringify({ cwd: path.join(project, 'src') }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(Object.values(statuses())[0].status, 'running');

  run(['notify', '--hook', 'done'], JSON.stringify({ workspacePaths: [project] }));
  assert.equal(Object.values(statuses())[0].status, 'done');

  // Unknown project: silent success, nothing recorded
  const before = JSON.stringify(statuses());
  const r2 = run(['notify', '--hook', 'input'], JSON.stringify({ cwd: '/nowhere' }));
  assert.equal(r2.status, 0);
  assert.equal(r2.stdout + r2.stderr, '');
  assert.equal(JSON.stringify(statuses()), before);
});
