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
// Short alias: `ca` launches CLI-Agent too
const ALIAS_LINK = path.join(os.homedir(), '.local', 'bin', 'ca');
const INSTALLED_ENTRY = path.join(INSTALL_DIR, 'bin', 'cli-agent.js');

/** True when `link` is a symlink into the install.sh directory (~/.cli-agent). */
function isOurLink(link) {
  try {
    return fs.lstatSync(link).isSymbolicLink() && path.resolve(path.dirname(link), fs.readlinkSync(link)).startsWith(INSTALL_DIR + path.sep);
  } catch (err) {
    return false;
  }
}

/**
 * Create the `ca` alias next to the `cli-agent` link for install.sh setups
 * (also covers updates done by an older version). Never replaces an existing
 * `ca` that is not ours. Returns 'ok' | 'created' | 'taken' | 'n/a'.
 */
function ensureAliasLink() {
  if (!isOurLink(BIN_LINK) || !fs.existsSync(INSTALLED_ENTRY)) return 'n/a';
  if (isOurLink(ALIAS_LINK)) return 'ok';
  try {
    fs.lstatSync(ALIAS_LINK);
    return 'taken';
  } catch (err) {
    // free
  }
  try {
    fs.symlinkSync(INSTALLED_ENTRY, ALIAS_LINK);
    return 'created';
  } catch (err) {
    return 'n/a';
  }
}
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
  cli-agent  (or: ca)                   Open the workspace (sidebar left, terminal right)
  cli-agent list                        List saved bookmarks
  cli-agent add <name> [path] [agent]   Add a bookmark (path defaults to current directory)
  cli-agent remove <name|index|path>    Delete a bookmark
  cli-agent notify <name|index|path> <status> [message]
                                        Set a status: input, running, done, error, rate_limit, clear
                                        (--quiet: exit 0 silently if no bookmark matches)
  cli-agent hooks [--install|--uninstall] [agents]
                                        Let Claude Code, Codex, Copilot, agy and OpenCode
                                        report their status (instead of guessing it)
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

/** Read the JSON payload an agent hook sends on stdin (if any). */
function readHookPayload() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = fs.readFileSync(0, 'utf-8');
    const data = raw.trim() ? JSON.parse(raw) : {};
    return data && typeof data === 'object' ? data : {};
  } catch (err) {
    return {};
  }
}

/**
 * Find the bookmark a hook is reporting for:
 * 1. the CLI-Agent tmux pane the agent runs in ($TMUX_PANE),
 * 2. the project directory from the hook payload / environment.
 */
function findHookBookmark(config) {
  const { isInsideCliAgent } = require('./tmux');
  const { bookmarkKeyForPane } = require('./monitor');
  if (isInsideCliAgent() && process.env.TMUX_PANE) {
    const key = bookmarkKeyForPane(process.env.TMUX_PANE);
    const bm = key && config.bookmarks.find(b => getBookmarkKey(b) === key);
    if (bm) return bm;
  }
  const payload = readHookPayload();
  const reported = [
    payload.cwd,
    ...(Array.isArray(payload.workspacePaths) ? payload.workspacePaths : []),
    process.env.CLAUDE_PROJECT_DIR
  ].filter(d => typeof d === 'string' && d);
  // Only fall back to our own cwd when the agent told us nothing: agy, for
  // instance, runs hooks from ~/.gemini/config.
  const candidates = reported.length ? reported : [process.cwd()];
  for (const dir of candidates) {
    if (typeof dir === 'string' && path.isAbsolute(dir)) {
      const bm = findBookmark(config, dir);
      if (bm) return bm;
    }
  }
  return null;
}

function handleNotify(rawArgs) {
  const { saveManualStatus, clearManualStatus } = require('./monitor');
  const hook = rawArgs.includes('--hook');
  const quiet = hook || rawArgs.includes('--quiet') || rawArgs.includes('-q');
  const args = rawArgs.filter(a => !['--quiet', '-q', '--hook'].includes(a));

  const fail = msg => {
    if (quiet) process.exit(0);
    console.error(`${colors.red}${msg}${colors.reset}`);
    process.exit(1);
  };

  // --hook <status>: the bookmark is found from the pane / payload
  const target = hook ? null : args[0];
  const rawStatus = String((hook ? args[0] : args[1]) || '').toLowerCase();
  const message = args.slice(hook ? 1 : 2).join(' ');

  if ((!hook && !target) || !rawStatus) {
    fail('Syntax: cli-agent notify <name|index|path> <status> [message]\n' +
      '        cli-agent notify --hook <status>   (from an agent hook)\n' +
      'Statuses: input, running, done, error, rate_limit, clear');
  }

  const statusKey = STATUS_ALIASES[rawStatus];
  if (!statusKey) fail(`Unknown status "${rawStatus}". Use: input, running, done, error, rate_limit, clear`);

  const config = loadConfig();
  const bookmark = hook ? findHookBookmark(config) : findBookmark(config, target);
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
// Agent status integrations (hooks / plugins)
// ---------------------------------------------------------------------------

function selectIntegrations(names, { detectedOnly }) {
  const { INTEGRATIONS, getIntegration } = require('./integrations');
  if (names.length === 0) return INTEGRATIONS.filter(i => !detectedOnly || i.detect());
  return names.map(n => {
    const integ = getIntegration(n);
    if (!integ) {
      console.error(`${colors.red}Unknown agent "${n}". Available: ${INTEGRATIONS.map(i => i.id).join(', ')}${colors.reset}`);
      process.exit(1);
    }
    return integ;
  });
}

function handleHooks(args) {
  const { INTEGRATIONS } = require('./integrations');
  const names = args.filter(a => !a.startsWith('-')).flatMap(a => a.split(',')).filter(Boolean);

  if (args.includes('--install') || args.includes('--uninstall')) {
    const install = args.includes('--install');
    const targets = selectIntegrations(names, { detectedOnly: install });
    if (targets.length === 0) {
      console.log('No supported agent found on this machine.');
      return;
    }
    console.log('');
    for (const integ of targets) {
      try {
        if (install) {
          integ.install();
          console.log(`  ${colors.green}✓${colors.reset} ${integ.name.padEnd(16)} ${colors.gray}${shrinkPath(integ.file())}${colors.reset}`);
          if (integ.note) console.log(`    ${colors.gray}${integ.note}${colors.reset}`);
        } else {
          const removed = integ.uninstall();
          console.log(`  ${removed ? `${colors.green}✓${colors.reset}` : `${colors.gray}-${colors.reset}`} ${integ.name.padEnd(16)} ${colors.gray}${removed ? 'removed' : 'nothing to remove'}${colors.reset}`);
        }
      } catch (err) {
        console.log(`  ${colors.red}✗${colors.reset} ${integ.name.padEnd(16)} ${err.message}`);
      }
    }
    console.log('');
    return;
  }

  console.log(`\n${colors.bold}Agent status integrations${colors.reset}`);
  console.log(`${colors.gray}Each agent reports its own status (working / waiting for you / done) to CLI-Agent,`);
  console.log(`instead of CLI-Agent guessing it from the screen.${colors.reset}\n`);
  for (const integ of INTEGRATIONS) {
    const detected = integ.detect();
    const installed = integ.isInstalled();
    const [label, color] = installed
      ? ['installed', colors.green]
      : (detected ? ['not installed', colors.yellow] : ['agent not found', colors.gray]);
    console.log(`  ${integ.id.padEnd(10)} ${integ.name.padEnd(16)} ${color}${label.padEnd(16)}${colors.reset} ${colors.gray}${shrinkPath(integ.file())}${colors.reset}`);
  }
  console.log(`\n  ${colors.cyan}cli-agent hooks --install${colors.reset}            install for every agent found`);
  console.log(`  ${colors.cyan}cli-agent hooks --install claude,agy${colors.reset} only some agents`);
  console.log(`  ${colors.cyan}cli-agent hooks --uninstall${colors.reset}          remove everything CLI-Agent added\n`);
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
  const alias = ensureAliasLink();
  if (alias === 'ok' || alias === 'created') ok('Short alias: ca');
  else if (alias === 'taken') warn(`${shrinkPath(ALIAS_LINK)} already exists and is not CLI-Agent: the "ca" alias is not available`);

  const { INTEGRATIONS } = require('./integrations');
  for (const integ of INTEGRATIONS) {
    if (!integ.detect()) continue;
    if (integ.isInstalled()) ok(`${integ.name}: status hooks installed`);
    else warn(`${integ.name}: status hooks not installed (run: cli-agent hooks --install)`);
  }

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

    ensureAliasLink();
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

  const targets = [BIN_LINK, ALIAS_LINK].filter(isOurLink);
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
  const { INTEGRATIONS } = require('./integrations');
  for (const integ of INTEGRATIONS) {
    try {
      if (integ.uninstall()) console.log(`  ${colors.gray}Removed ${integ.name} status hooks${colors.reset}`);
    } catch (err) {
      // leave a file we cannot parse untouched
    }
  }
  for (const t of targets) fs.rmSync(t, { recursive: true, force: true });
  console.log(`\n${colors.green}✓ CLI-Agent uninstalled.${colors.reset}\n`);
}

// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd) {
    ensureAliasLink();
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

module.exports = { main, STATUS_ALIASES };
