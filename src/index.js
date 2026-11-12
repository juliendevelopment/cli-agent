const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const {
  loadConfig,
  addBookmark,
  removeBookmark,
  findBookmark,
  getBookmarkKey,
  getConfigDir,
  getConfigFile,
  shrinkPath,
  clampWidth
} = require('./config');
const { startWorkspace, killSession, getTmuxVersion, keyLabel } = require('./tmux');
const { getAgentsWithStatus } = require('./agents');
const { commandExists, shQuote } = require('./exec');
const { colors } = require('./ui');
const { VERSION } = require('./version');

const REPO = 'juliendevelopment/cli-agent';
const INSTALL_DIR = path.join(os.homedir(), '.cli-agent');
const BIN_LINK = path.join(os.homedir(), '.local', 'bin', 'cli-agent');
const ENTRYPOINT = path.resolve(__dirname, '..', 'bin', 'cli-agent.js');

function printHelp() {
  const config = loadConfig();
  const switcher = keyLabel(config.switcherKey || 'C-e');
  const agentKeys = getAgentsWithStatus(config)
    .filter(a => a.shortcut)
    .map(a => `  ${a.shortcut.padEnd(15)}Launch ${a.name} in the directory`)
    .join('\n');

  console.log(`
${colors.bold}${colors.brightCyan}🤖 CLI-AGENT${colors.reset} v${VERSION} - AI Agent Terminal Workspace Manager

${colors.bold}USAGE:${colors.reset}
  cli-agent                             Open the workspace (sidebar left, terminal right)
  cli-agent list                        List saved bookmarks
  cli-agent add <name> [path] [agent]   Add a bookmark (path defaults to current directory)
  cli-agent remove <name|index|path>    Delete a bookmark
  cli-agent notify <name|index|path> <status> [message]
                                        Set a status: input, running, done, error, rate_limit, clear
                                        (--quiet: exit 0 silently if no bookmark matches)
  cli-agent hooks [--install]           Show / install Claude Code hooks for reliable statuses
  cli-agent doctor                      Check dependencies and configuration
  cli-agent update                      Update to the latest GitHub release
  cli-agent uninstall [--yes] [--purge] Remove CLI-Agent (--purge also deletes the config)
  cli-agent kill                        Close the CLI-Agent tmux session
  cli-agent version                     Print the version
  cli-agent help                        Display this help message

${colors.bold}GLOBAL SHORTCUTS (INSIDE CLI-AGENT):${colors.reset}
  ${switcher.padEnd(14)} Quick switcher popup (Enter = toggle last 2 sessions)
  Alt + ← / M-h  Jump to the sidebar
  Alt + → / M-l  Jump to the terminal pane
  F1 / F2        Focus sidebar / terminal
  F3             Toggle mouse capture (for native text selection)
  Shift + Drag   Select text natively and copy with Ctrl+Shift+C

${colors.bold}IN THE SIDEBAR:${colors.reset}
  ↑ / ↓          Navigate bookmarks (mouse wheel works too)
  Enter / s      Open the selected directory in the right terminal
${agentKeys}
  o / Space      Choose an agent from a list
  a / e / d      Add / edit / delete a bookmark
  < / >          Shrink / expand the sidebar (w: cycle 24/30/38 cols)
  r              Reset the live status
  Tab            Focus the terminal
  q              Quit CLI-Agent (closes all sessions)

Config: ${shrinkPath(getConfigFile())}
`);
}

function handleList() {
  const config = loadConfig();
  console.log(`\n${colors.bold}${colors.brightYellow}📁 Your CLI-Agent bookmarks (${config.bookmarks.length}):${colors.reset}\n`);
  if (config.bookmarks.length === 0) {
    console.log(`  ${colors.gray}No bookmarks configured.${colors.reset}`);
    console.log(`  Run ${colors.cyan}cli-agent add <name> <path>${colors.reset} to add one.\n`);
    return;
  }

  config.bookmarks.forEach((bm, i) => {
    const num = `${i + 1}.`.padEnd(3);
    const name = colors.bold + String(bm.name).padEnd(24) + colors.reset;
    const missing = fs.existsSync(bm.path) ? '' : ` ${colors.red}(missing)${colors.reset}`;
    const p = colors.cyan + shrinkPath(bm.path) + colors.reset + missing;
    const ag = colors.gray + `[${bm.agent || 'claude'}]` + colors.reset;
    console.log(`  ${colors.brightGreen}${num}${colors.reset} ${name} ${p} ${ag}`);
  });
  console.log('');
}

function handleAdd(args) {
  const [name, targetPath = '.', agent = 'claude'] = args;

  if (!name) {
    console.error(`${colors.red}Error: Please specify a bookmark name.${colors.reset}`);
    console.log('Example: cli-agent add "My Project" /path/to/project');
    process.exit(1);
  }

  const agents = getAgentsWithStatus(loadConfig());
  if (!agents.some(a => a.id === agent)) {
    console.error(`${colors.red}Error: unknown agent "${agent}". Available: ${agents.map(a => a.id).join(', ')}${colors.reset}`);
    process.exit(1);
  }

  const bm = addBookmark(name, targetPath, agent);
  console.log(`${colors.green}✓ Bookmark created:${colors.reset}`);
  console.log(`  Name   : ${colors.bold}${bm.name}${colors.reset}`);
  console.log(`  Path   : ${colors.cyan}${bm.path}${colors.reset}${fs.existsSync(bm.path) ? '' : ` ${colors.yellow}(does not exist yet)${colors.reset}`}`);
  console.log(`  Agent  : ${colors.yellow}${bm.agent}${colors.reset}\n`);
}

function handleRemove(args) {
  const target = args.join(' ').trim();
  if (!target) {
    console.error(`${colors.red}Error: Specify the name, index or path of the bookmark to delete.${colors.reset}`);
    process.exit(1);
  }

  const removed = removeBookmark(target);
  if (removed) {
    console.log(`${colors.green}✓ Bookmark "${removed.name}" deleted.${colors.reset}\n`);
  } else {
    console.error(`${colors.red}Bookmark not found: ${target}${colors.reset}\n`);
    process.exit(1);
  }
}

function handleKill() {
  if (killSession()) {
    console.log(`${colors.green}CLI-Agent session closed.${colors.reset}`);
  } else {
    console.log(`${colors.gray}No CLI-Agent session running.${colors.reset}`);
  }
}

const STATUS_ALIASES = {
  input: 'input_required',
  input_required: 'input_required',
  action: 'input_required',
  running: 'running',
  run: 'running',
  done: 'done',
  success: 'done',
  error: 'error',
  fail: 'error',
  rate_limit: 'rate_limit',
  quota: 'rate_limit',
  idle: 'clear',
  clear: 'clear'
};

function handleNotify(rawArgs) {
  const { saveManualStatus, clearManualStatus } = require('./monitor');
  const quiet = rawArgs.includes('--quiet') || rawArgs.includes('-q');
  const args = rawArgs.filter(a => a !== '--quiet' && a !== '-q');
  const target = args[0];
  const rawStatus = (args[1] || '').toLowerCase();
  const message = args.slice(2).join(' ');

  const fail = msg => {
    if (quiet) process.exit(0);
    console.error(`${colors.red}${msg}${colors.reset}`);
    process.exit(1);
  };

  if (!target || !rawStatus) {
    fail('Syntax: cli-agent notify <name|index|path> <status> [message]\n' +
      'Statuses: input, running, done, error, rate_limit, clear');
  }

  const statusKey = STATUS_ALIASES[rawStatus];
  if (!statusKey) fail(`Unknown status "${rawStatus}". Use: input, running, done, error, rate_limit, clear`);

  const bookmark = findBookmark(loadConfig(), target);
  if (!bookmark) fail(`Bookmark not found: ${target}`);

  const key = getBookmarkKey(bookmark);
  if (statusKey === 'clear') {
    clearManualStatus(key);
    clearManualStatus(bookmark.name);
  } else {
    saveManualStatus(key, statusKey, message);
  }
  if (!quiet) {
    console.log(`${colors.green}✓ Status of "${bookmark.name}" set to: ${statusKey}${colors.reset}`);
  }
}

// ---------------------------------------------------------------------------
// Claude Code hooks
// ---------------------------------------------------------------------------

function notifyCommand(status) {
  const base = commandExists('cli-agent')
    ? 'cli-agent'
    : `${shQuote(process.execPath)} ${shQuote(ENTRYPOINT)}`;
  return `${base} notify --quiet "$CLAUDE_PROJECT_DIR" ${status}`;
}

function buildHooks() {
  const entry = status => [{ hooks: [{ type: 'command', command: notifyCommand(status) }] }];
  return {
    UserPromptSubmit: entry('running'),
    PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: notifyCommand('running') }] }],
    // Only real blocking prompts (not the "idle for 60s" reminder)
    Notification: [{ matcher: 'permission_prompt|elicitation_dialog', hooks: [{ type: 'command', command: notifyCommand('input') }] }],
    Stop: entry('done')
  };
}

function isOurHook(group) {
  return Array.isArray(group && group.hooks) &&
    group.hooks.some(h => typeof h.command === 'string' && /cli-agent(\.js)?'?\s+notify\b/.test(h.command));
}

function handleHooks(args) {
  const hooks = buildHooks();
  const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');

  if (!args.includes('--install')) {
    console.log(`\n${colors.bold}Claude Code hooks for CLI-Agent${colors.reset}`);
    console.log(`Add this to ${shrinkPath(settingsFile)} (or run ${colors.cyan}cli-agent hooks --install${colors.reset}):\n`);
    console.log(JSON.stringify({ hooks }, null, 2));
    console.log(`\n${colors.gray}Statuses are then reported by Claude Code itself instead of being guessed from the terminal output.${colors.reset}\n`);
    return;
  }

  let settings = {};
  if (fs.existsSync(settingsFile)) {
    const raw = fs.readFileSync(settingsFile, 'utf-8');
    try {
      settings = JSON.parse(raw);
    } catch (err) {
      console.error(`${colors.red}${settingsFile} is not valid JSON; not modifying it.${colors.reset}`);
      process.exit(1);
    }
    const backup = `${settingsFile}.bak-${Date.now()}`;
    fs.writeFileSync(backup, raw, 'utf-8');
    console.log(`${colors.gray}Backup saved to ${shrinkPath(backup)}${colors.reset}`);
  }

  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  for (const [event, groups] of Object.entries(hooks)) {
    const existing = Array.isArray(settings.hooks[event]) ? settings.hooks[event].filter(g => !isOurHook(g)) : [];
    settings.hooks[event] = [...existing, ...groups];
  }

  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  console.log(`${colors.green}✓ Hooks installed in ${shrinkPath(settingsFile)}${colors.reset}`);
  console.log(`${colors.gray}Restart running Claude Code sessions to pick them up.${colors.reset}\n`);
}

// ---------------------------------------------------------------------------
// doctor / update / uninstall
// ---------------------------------------------------------------------------

function handleDoctor() {
  let problems = 0;
  const ok = msg => console.log(`  ${colors.green}✓${colors.reset} ${msg}`);
  const warn = msg => console.log(`  ${colors.yellow}!${colors.reset} ${msg}`);
  const bad = msg => {
    problems++;
    console.log(`  ${colors.red}✗${colors.reset} ${msg}`);
  };

  console.log(`\n${colors.bold}CLI-Agent doctor${colors.reset} (v${VERSION})\n`);

  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor >= 18) ok(`Node.js ${process.version}`);
  else bad(`Node.js ${process.version} (>= 18 required)`);

  const tmuxVersion = getTmuxVersion();
  if (!tmuxVersion) bad('tmux not found');
  else if (tmuxVersion.major > 3 || (tmuxVersion.major === 3 && tmuxVersion.minor >= 2)) ok(tmuxVersion.raw);
  else warn(`${tmuxVersion.raw} (>= 3.2 recommended for the switcher popup)`);

  const config = loadConfig();
  if (config.__corrupt) bad(`${shrinkPath(getConfigFile())} is not valid JSON (copy in bookmarks.json.corrupt)`);
  else ok(`Config: ${shrinkPath(getConfigFile())} (${config.bookmarks.length} bookmarks)`);

  for (const bm of config.bookmarks) {
    if (!fs.existsSync(bm.path)) warn(`Bookmark "${bm.name}": missing directory ${shrinkPath(bm.path)}`);
  }

  for (const agent of getAgentsWithStatus(config)) {
    if (!agent.cmd) continue;
    if (agent.installed) ok(`Agent ${agent.name}: ${agent.cmd}`);
    else warn(`Agent ${agent.name}: "${agent.cmd.split(' ')[0]}" not found in PATH`);
  }

  const clip = ['wl-copy', 'xclip', 'pbcopy'].filter(commandExists);
  if (clip.length) ok(`Clipboard: ${clip.join(', ')}`);
  else warn('No clipboard tool (wl-copy / xclip / pbcopy): copy relies on OSC 52 only');

  if (commandExists('cli-agent')) ok('cli-agent is in PATH');
  else warn('cli-agent is not in PATH (add ~/.local/bin to PATH)');

  const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
  let hooksInstalled = false;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    hooksInstalled = Object.values(settings.hooks || {}).some(groups => Array.isArray(groups) && groups.some(isOurHook));
  } catch (err) {
    // no settings
  }
  if (hooksInstalled) ok('Claude Code hooks installed');
  else warn('Claude Code hooks not installed (run: cli-agent hooks --install)');

  console.log(problems ? `\n${colors.red}${problems} problem(s) found.${colors.reset}\n` : `\n${colors.green}All good.${colors.reset}\n`);
  if (problems) process.exit(1);
}

function fetchLatestTarballUrl() {
  try {
    const json = execSync(`curl -fsSL https://api.github.com/repos/${REPO}/releases/latest`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000
    });
    const release = JSON.parse(json);
    if (release.tarball_url) return { url: release.tarball_url, label: release.tag_name };
  } catch (err) {
    // no release published yet
  }
  return { url: `https://api.github.com/repos/${REPO}/tarball/main`, label: 'main' };
}

function handleUpdate() {
  console.log(`\n${colors.bold}${colors.brightCyan}🔄 Updating CLI-Agent...${colors.reset}`);
  fs.mkdirSync(INSTALL_DIR, { recursive: true });

  try {
    const { url, label } = fetchLatestTarballUrl();
    console.log(`${colors.gray}Downloading ${label}...${colors.reset}`);
    const tarCmd = `tar -xz --strip-components=1 -C ${shQuote(INSTALL_DIR)}`;
    execSync(`curl -fsSL ${shQuote(url)} | ${tarCmd}`, { stdio: 'inherit', shell: '/bin/bash' });

    const binFile = path.join(INSTALL_DIR, 'bin', 'cli-agent.js');
    if (fs.existsSync(binFile)) fs.chmodSync(binFile, 0o755);

    const newVersion = JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, 'package.json'), 'utf-8')).version;
    console.log(`\n${colors.bold}${colors.green}✨ CLI-Agent updated: v${VERSION} → v${newVersion}${colors.reset}`);
    console.log(`${colors.gray}Your bookmarks in ${shrinkPath(getConfigDir())} were preserved.${colors.reset}`);
    console.log(`${colors.gray}Restart the workspace (cli-agent kill && cli-agent) to use the new version.${colors.reset}\n`);
  } catch (err) {
    console.error(`\n${colors.red}❌ Update failed: ${err.message}${colors.reset}`);
    console.log('You can also re-run the install command:');
    console.log(`  ${colors.yellow}curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash${colors.reset}\n`);
    process.exit(1);
  }
}

function handleUninstall(args) {
  const yes = args.includes('--yes') || args.includes('-y');
  const purge = args.includes('--purge');

  const targets = [];
  try {
    if (fs.lstatSync(BIN_LINK).isSymbolicLink() && fs.readlinkSync(BIN_LINK).startsWith(INSTALL_DIR)) {
      targets.push(BIN_LINK);
    }
  } catch (err) {
    // no link
  }
  if (fs.existsSync(path.join(INSTALL_DIR, 'bin', 'cli-agent.js'))) targets.push(INSTALL_DIR);
  if (purge && fs.existsSync(getConfigDir())) targets.push(getConfigDir());

  if (targets.length === 0) {
    console.log('Nothing to remove (CLI-Agent was not installed with install.sh).');
    return;
  }

  console.log(`\n${colors.bold}The following will be removed:${colors.reset}`);
  targets.forEach(t => console.log(`  - ${t}`));
  if (!purge) console.log(`${colors.gray}  (bookmarks in ${shrinkPath(getConfigDir())} are kept; add --purge to delete them)${colors.reset}`);

  if (!yes) {
    console.log(`\nRe-run with ${colors.cyan}cli-agent uninstall --yes${colors.reset} to confirm.\n`);
    return;
  }

  killSession();
  for (const t of targets) fs.rmSync(t, { recursive: true, force: true });
  console.log(`\n${colors.green}✓ CLI-Agent uninstalled.${colors.reset}\n`);
}

// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd) {
    const config = loadConfig();
    const defaultBm = config.bookmarks[config.selectedIndex || 0];
    startWorkspace({ initialBookmark: defaultBm, scriptPath: ENTRYPOINT, initialWidth: clampWidth(config.sidebarWidth) });
    return;
  }

  const rest = args.slice(1);
  switch (cmd) {
    case '--sidebar':
      require('./sidebar').runSidebar();
      break;
    case '--switcher':
    case 'switcher':
      require('./switcher').runSwitcher();
      break;
    case 'list':
    case 'ls':
      handleList();
      break;
    case 'add':
      handleAdd(rest);
      break;
    case 'remove':
    case 'rm':
    case 'delete':
      handleRemove(rest);
      break;
    case 'notify':
      handleNotify(rest);
      break;
    case 'hooks':
      handleHooks(rest);
      break;
    case 'doctor':
      handleDoctor();
      break;
    case 'update':
    case 'upgrade':
      handleUpdate();
      break;
    case 'uninstall':
      handleUninstall(rest);
      break;
    case 'kill':
      handleKill();
      break;
    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION);
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(`${colors.red}Unknown command: ${cmd}${colors.reset}`);
      printHelp();
      process.exit(1);
  }
}

module.exports = { main, buildHooks, isOurHook, STATUS_ALIASES };
