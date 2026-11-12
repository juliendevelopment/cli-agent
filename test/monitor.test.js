const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-agent-test-'));
process.env.XDG_CONFIG_HOME = tmpHome;

const monitor = require('../src/monitor');

const { STATUS_TYPES: S, detectTerminalStatus } = monitor;
const agent = { isAgent: true };
const shell = { isAgent: false };

test.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

test('detectTerminalStatus: empty output is idle', () => {
  assert.equal(detectTerminalStatus('', agent), S.IDLE);
  assert.equal(detectTerminalStatus('\n\n', agent), S.IDLE);
});

test('detectTerminalStatus: Claude permission menu requires input', () => {
  const out = [
    'Bash command',
    '  rm -rf build',
    'Do you want to proceed?',
    '❯ 1. Yes',
    "  2. Yes, and don't ask again for rm commands",
    '  3. No, and tell Claude what to do differently (esc)'
  ].join('\n');
  assert.equal(detectTerminalStatus(out, agent), S.INPUT_REQUIRED);
});

test('detectTerminalStatus: y/n prompts require input', () => {
  assert.equal(detectTerminalStatus('Overwrite file? (y/n)', shell), S.INPUT_REQUIRED);
  assert.equal(detectTerminalStatus('Continue? [Y/n] ', shell), S.INPUT_REQUIRED);
});

test('detectTerminalStatus: a conversational question is not an action', () => {
  const out = 'Would you like me to also update the README?\n> ';
  assert.equal(detectTerminalStatus(out, agent), S.IDLE);
});

test('detectTerminalStatus: running only while an agent is in the foreground', () => {
  const out = '✻ Thinking… (12s · esc to interrupt)';
  assert.equal(detectTerminalStatus(out, agent), S.RUNNING);
  assert.equal(detectTerminalStatus(out, shell), S.IDLE);
  // Plain words like "reading" no longer trigger RUNNING
  assert.equal(detectTerminalStatus('reading config\nediting file', agent), S.IDLE);
});

test('detectTerminalStatus: rate limit, error and done', () => {
  assert.equal(detectTerminalStatus('Error: rate limit reached, retry later', agent), S.RATE_LIMIT);
  assert.equal(detectTerminalStatus('$ git push\nfatal: not a git repository', shell), S.ERROR);
  assert.equal(detectTerminalStatus('npm ERR! code ENOENT', shell), S.ERROR);
  assert.equal(detectTerminalStatus('✨ Done in 3.2s', shell), S.DONE);
});

test('parseGitStatus extracts branch and change count', () => {
  assert.deepEqual(monitor.parseGitStatus('## main...origin/main [ahead 1]\n M a.js\n?? b.js\n'), {
    branch: 'main', isDirty: true, changedCount: 2, summary: 'main* (2)'
  });
  assert.equal(monitor.parseGitStatus('## feature/x\n').isDirty, false);
  assert.equal(monitor.parseGitStatus('## No commits yet on main\n').branch, 'main');
  assert.equal(monitor.parseGitStatus('## HEAD (no branch)\n').branch, 'detached');
});

test('getManualStatus ignores idle and expired entries', () => {
  const now = Date.now();
  const fresh = new Date(now - 1000).toISOString();
  const old = new Date(now - monitor.MANUAL_STATUS_TTL_MS - 1000).toISOString();
  const statuses = {
    a: { status: 'done', updatedAt: fresh },
    b: { status: 'done', updatedAt: old },
    c: { status: 'idle', updatedAt: fresh }
  };
  assert.equal(monitor.getManualStatus(statuses, 'a', now).status, 'done');
  assert.equal(monitor.getManualStatus(statuses, 'b', now), null);
  assert.equal(monitor.getManualStatus(statuses, 'c', now), null);
  assert.equal(monitor.getManualStatus(statuses, 'missing', now), null);
});

test('resolveStatus combines manual and detected statuses', () => {
  const running = { status: 'running' };
  const done = { status: 'done' };
  // Transient manual status dropped once the agent left the foreground
  assert.equal(monitor.resolveStatus(running, S.IDLE, shell), S.IDLE);
  assert.equal(monitor.resolveStatus(running, S.IDLE, agent), S.RUNNING);
  // A live blocking prompt wins over a manual "done"
  assert.equal(monitor.resolveStatus(done, S.INPUT_REQUIRED, agent), S.INPUT_REQUIRED);
  assert.equal(monitor.resolveStatus(done, S.IDLE, shell), S.DONE);
  assert.equal(monitor.resolveStatus(null, null, null), S.IDLE);
});

test('manual statuses are saved and cleared (not frozen to idle)', () => {
  monitor.saveManualStatus('k', 'done', 'ok');
  assert.equal(monitor.loadManualStatuses().k.status, 'done');
  monitor.clearManualStatus('k');
  assert.equal('k' in monitor.loadManualStatuses(), false);
});
