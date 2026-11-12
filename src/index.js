const path = require('path');
const { loadConfig, addBookmark, removeBookmark, shrinkPath, resolvePath } = require('./config');
const { startWorkspace, killSession, sessionExists, isInsideTmux } = require('./tmux');
const { runSidebar } = require('./sidebar');
const { runSwitcher } = require('./switcher');
const { colors } = require('./ui');

function printHelp() {
  console.log(`
${colors.bold}${colors.brightCyan}🤖 CLI-AGENT${colors.reset} - AI Agent Terminal Workspace Manager

${colors.bold}USAGE:${colors.reset}
  cli-agent                      Open split workspace (Menu on left, Terminal on right)
  cli-agent list                 List all saved project bookmarks
  cli-agent add <name> [path]    Add a new bookmark (. for current directory)
  cli-agent remove <name|index>  Delete a bookmark
  cli-agent notify <name> <stat> Set bookmark status (input, running, done, error, clear)
  cli-agent update               Update CLI-Agent to the latest GitHub release
  cli-agent kill                 Close active CLI-Agent tmux session
  cli-agent help                 Display this help message

${colors.bold}GLOBAL SHORTCUTS (ANYWHERE IN TERMINAL):${colors.reset}
  Ctrl + E       IntelliJ-style Quick Switcher popup (Enter = toggle last 2 sessions!)
  Alt + ← / M-h  Jump back to sidebar menu from the right terminal
  Alt + → / M-l  Jump from sidebar to terminal pane
  F1 / F2        Toggle focus between sidebar and terminal
  F3             Toggle mouse capture on/off (for easy native text selection)
  Shift + Drag   Select text natively and copy with Ctrl+Shift+C

${colors.bold}IN THE TERMINAL SIDEBAR:${colors.reset}
  ↑ / ↓          Navigate bookmarks
  Enter          Open selected directory in the right terminal
  c              Launch Claude Code in the directory
  p              Launch GitHub Copilot in the directory
  a              Add a new bookmark interactively
  d              Delete selected bookmark
  < / >          Shrink / expand sidebar width
  w              Cycle width presets (24, 30, 38 cols)
  r              Reset / clear live status
  q              Quit CLI-Agent
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
    const name = colors.bold + bm.name.padEnd(24) + colors.reset;
    const p = colors.cyan + shrinkPath(bm.path) + colors.reset;
    const ag = colors.gray + `[${bm.agent || 'claude'}]` + colors.reset;
    console.log(`  ${colors.brightGreen}${num}${colors.reset} ${name} ${p} ${ag}`);
  });
  console.log('');
}

function handleAdd(args) {
  const name = args[0];
  const targetPath = args[1] || '.';
  const agent = args[2] || 'claude';

  if (!name) {
    console.error(`${colors.red}Error: Please specify a bookmark name.${colors.reset}`);
    console.log(`Example: cli-agent add "My Project" /path/to/project`);
    process.exit(1);
  }

  const bm = addBookmark(name, targetPath, agent);
  console.log(`${colors.green}✓ Bookmark created successfully:${colors.reset}`);
  console.log(`  Name   : ${colors.bold}${bm.name}${colors.reset}`);
  console.log(`  Path   : ${colors.cyan}${bm.path}${colors.reset}`);
  console.log(`  Agent  : ${colors.yellow}${bm.agent}${colors.reset}\n`);
}

function handleRemove(args) {
  const target = args[0];
  if (!target) {
    console.error(`${colors.red}Error: Specify the name or index of the bookmark to delete.${colors.reset}`);
    process.exit(1);
  }

  const num = parseInt(target, 10);
  let removed = null;
  if (!isNaN(num) && num > 0) {
    removed = removeBookmark(num - 1);
  } else {
    removed = removeBookmark(target);
  }

  if (removed) {
    console.log(`${colors.green}✓ Bookmark "${removed.name}" deleted.${colors.reset}\n`);
  } else {
    console.log(`${colors.red}Bookmark not found: ${target}${colors.reset}\n`);
  }
}

function handleKill() {
  killSession();
  console.log(`${colors.green}CLI-Agent session closed.${colors.reset}`);
}

function handleUpdate() {
  const fs = require('fs');
  const os = require('os');
  const { execSync } = require('child_process');
  const installDir = path.join(os.homedir(), '.cli-agent');

  console.log(`\n${colors.bold}${colors.brightCyan}🔄 Updating CLI-Agent...${colors.reset}`);

  if (!fs.existsSync(installDir)) {
    fs.mkdirSync(installDir, { recursive: true });
  }

  try {
    console.log(`${colors.gray}Downloading the latest release from GitHub...${colors.reset}`);
    const downloadCmd = `curl -fsSL https://api.github.com/repos/juliendevelopment/cli-agent/tarball/main 2>/dev/null | tar -xz --strip-components=1 -C "${installDir}" || (gh api repos/juliendevelopment/cli-agent/tarball/main | tar -xz --strip-components=1 -C "${installDir}")`;
    execSync(downloadCmd, { stdio: 'inherit' });

    const binFile = path.join(installDir, 'bin', 'cli-agent.js');
    if (fs.existsSync(binFile)) {
      execSync(`chmod +x "${binFile}"`, { stdio: 'ignore' });
    }

    console.log(`\n${colors.bold}${colors.green}✨ CLI-Agent has been successfully updated!${colors.reset}`);
    console.log(`${colors.gray}Your bookmarks in ~/.config/cli-agent/ were safely preserved.${colors.reset}\n`);
  } catch (err) {
    console.error(`\n${colors.red}❌ Update failed: ${err.message}${colors.reset}`);
    console.log(`You can also re-run the install command:`);
    console.log(`  ${colors.yellow}curl -fsSL https://raw.githubusercontent.com/juliendevelopment/cli-agent/main/install.sh | bash${colors.reset}\n`);
  }
}

function handleNotify(args) {
  const { saveManualStatus } = require('./monitor');
  const target = args[0];
  const rawStatus = (args[1] || '').toLowerCase();
  const message = args.slice(2).join(' ') || '';

  if (!target || !rawStatus) {
    console.error(`${colors.red}Error: Syntax: cli-agent notify <name|index> <status> [message]${colors.reset}`);
    console.log(`Available statuses: input, running, done, error, rate_limit, idle (or clear)`);
    process.exit(1);
  }

  const config = loadConfig();
  let bookmark = null;
  const num = parseInt(target, 10);
  if (!isNaN(num) && num > 0 && num <= config.bookmarks.length) {
    bookmark = config.bookmarks[num - 1];
  } else {
    bookmark = config.bookmarks.find(b => b.name.toLowerCase() === target.toLowerCase() || b.id === target);
  }

  if (!bookmark) {
    console.error(`${colors.red}Bookmark not found: ${target}${colors.reset}`);
    process.exit(1);
  }

  const statusMap = {
    input: 'input_required',
    action: 'input_required',
    running: 'running',
    run: 'running',
    done: 'done',
    success: 'done',
    error: 'error',
    fail: 'error',
    rate_limit: 'rate_limit',
    quota: 'rate_limit',
    idle: 'idle',
    clear: 'idle'
  };

  const statusKey = statusMap[rawStatus] || 'idle';
  const key = bookmark.id || bookmark.name;
  saveManualStatus(key, statusKey, message);
  console.log(`${colors.green}✓ Status of "${bookmark.name}" updated to: ${statusKey}${colors.reset}\n`);
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd) {
    // Launch workspace
    const config = loadConfig();
    const defaultBm = config.bookmarks[config.selectedIndex || 0];
    const initialWidth = config.sidebarWidth || 26;
    const entrypoint = path.resolve(__dirname, '..', 'bin', 'cli-agent.js');
    startWorkspace({ initialBookmark: defaultBm, scriptPath: entrypoint, initialWidth });
    return;
  }

  switch (cmd) {
    case '--sidebar':
      runSidebar();
      break;
    case '--switcher':
    case 'switcher':
      runSwitcher();
      break;
    case 'list':
    case 'ls':
      handleList();
      break;
    case 'add':
      handleAdd(args.slice(1));
      break;
    case 'remove':
    case 'rm':
    case 'delete':
      handleRemove(args.slice(1));
      break;
    case 'notify':
      handleNotify(args.slice(1));
      break;
    case 'update':
    case 'upgrade':
      handleUpdate();
      break;
    case 'kill':
      handleKill();
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(`Commande inconnue : ${cmd}`);
      printHelp();
      process.exit(1);
  }
}

module.exports = { main };
