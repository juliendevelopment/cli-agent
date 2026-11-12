const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate the config directory before loading the module.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-agent-test-'));
process.env.XDG_CONFIG_HOME = tmpHome;

const config = require('../src/config');

const configFile = () => config.getConfigFile();
const reset = () => fs.rmSync(path.join(tmpHome, 'cli-agent'), { recursive: true, force: true });

test.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

test('resolvePath expands ~ and relative paths', () => {
  assert.equal(config.resolvePath('~'), os.homedir());
  assert.equal(config.resolvePath('~/foo'), path.join(os.homedir(), 'foo'));
  assert.equal(config.resolvePath('.'), process.cwd());
  assert.equal(config.resolvePath('/a/../b'), '/b');
  assert.equal(config.resolvePath(''), process.cwd());
});

test('shrinkPath replaces the home directory with ~', () => {
  assert.equal(config.shrinkPath(os.homedir()), '~');
  assert.equal(config.shrinkPath(path.join(os.homedir(), 'x')), '~/x');
  assert.equal(config.shrinkPath('/etc'), '/etc');
});

test('clampWidth falls back to the default outside bounds', () => {
  assert.equal(config.clampWidth(30), 30);
  assert.equal(config.clampWidth(30.4), 30);
  assert.equal(config.clampWidth(5), config.DEFAULT_SIDEBAR_WIDTH);
  assert.equal(config.clampWidth(500), config.DEFAULT_SIDEBAR_WIDTH);
  assert.equal(config.clampWidth('abc'), config.DEFAULT_SIDEBAR_WIDTH);
  assert.equal(config.clampWidth(undefined), config.DEFAULT_SIDEBAR_WIDTH);
});

test('getBookmarkKey sanitises ids', () => {
  assert.equal(config.getBookmarkKey({ id: 'bm_1' }), 'bm_1');
  assert.equal(config.getBookmarkKey({ id: 'a b/c$' }), 'a_b_c_');
  assert.equal(config.getBookmarkKey({ name: 'My Proj' }), 'My_Proj');
  assert.equal(config.getBookmarkKey(null), 'default');
});

test('findBookmarkIndex matches index, id, name and path', () => {
  const bms = [
    { id: 'one', name: 'Backend API', path: '/srv/backend' },
    { id: 'two', name: 'Front', path: '/srv/front' },
    { id: 'three', name: 'Nested', path: '/srv/front/packages/ui' }
  ];
  assert.equal(config.findBookmarkIndex(bms, '1'), 0);
  assert.equal(config.findBookmarkIndex(bms, '3'), 2);
  assert.equal(config.findBookmarkIndex(bms, '4'), -1);
  assert.equal(config.findBookmarkIndex(bms, 'two'), 1);
  assert.equal(config.findBookmarkIndex(bms, 'backend api'), 0);
  assert.equal(config.findBookmarkIndex(bms, '/srv/front'), 1);
  assert.equal(config.findBookmarkIndex(bms, '/srv/front/src/x.js'), 1);
  // Deepest bookmark containing the path wins
  assert.equal(config.findBookmarkIndex(bms, '/srv/front/packages/ui/src'), 2);
  // Sibling with a common prefix is not "inside"
  assert.equal(config.findBookmarkIndex(bms, '/srv/frontend'), -1);
  assert.equal(config.findBookmarkIndex(bms, ''), -1);
  assert.equal(config.findBookmarkIndex(bms, 'nope'), -1);
});

test('first run creates a default config', () => {
  reset();
  const cfg = config.loadConfig();
  assert.equal(cfg.bookmarks.length, 1);
  assert.ok(fs.existsSync(configFile()));
});

test('add / remove by name / update round-trip', () => {
  reset();
  config.loadConfig();
  const bm = config.addBookmark('My Project', '/tmp', 'claude');
  assert.equal(bm.path, '/tmp');
  assert.equal(config.loadConfig().bookmarks.length, 2);

  config.updateBookmark(1, { name: 'Renamed' });
  assert.equal(config.loadConfig().bookmarks[1].name, 'Renamed');

  const removed = config.removeBookmark('renamed');
  assert.equal(removed.id, bm.id);
  assert.equal(config.loadConfig().bookmarks.length, 1);
  assert.equal(config.removeBookmark('does not exist'), null);
});

test('a corrupt config is backed up and never overwritten', () => {
  reset();
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  const garbage = '{"bookmarks": [ {"name": "half wri';
  fs.writeFileSync(configFile(), garbage);

  const origWrite = process.stderr.write;
  process.stderr.write = () => true;
  let cfg;
  try {
    cfg = config.loadConfig();
  } finally {
    process.stderr.write = origWrite;
  }

  assert.equal(cfg.__corrupt, true);
  assert.deepEqual(cfg.bookmarks, []);
  assert.equal(fs.readFileSync(`${configFile()}.corrupt`, 'utf-8'), garbage);

  // Saving the in-memory fallback must not clobber the user's file
  assert.equal(config.saveConfig(cfg), false);
  assert.equal(fs.readFileSync(configFile(), 'utf-8'), garbage);
});

test('writeJsonAtomic leaves no temp files behind', () => {
  reset();
  const file = path.join(tmpHome, 'cli-agent', 'x.json');
  config.writeJsonAtomic(file, { a: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), { a: 1 });
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(f => f.endsWith('.tmp')), []);
});

test('recordActiveSession keeps a deduplicated history', () => {
  reset();
  config.loadConfig();
  config.recordActiveSession('a');
  config.recordActiveSession('b');
  config.recordActiveSession('a');
  assert.deepEqual(config.getRecentHistory(), ['a', 'b']);
  assert.equal(config.loadConfig().activeBookmarkId, 'a');
});
