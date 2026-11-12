# 🤖 CLI-Agent

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Linux%20%7C%20macOS-brightgreen.svg)](#requirements)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](#requirements)
[![tmux](https://img.shields.io/badge/Powered%20by-tmux-orange.svg)](#architecture)

> **AI Agent Terminal Workspace Manager**  
> A split-pane terminal environment with project bookmarks on the left and an interactive shell on the right to launch your AI agents (**Claude Code**, **GitHub Copilot CLI**, etc.) without manually changing directories.

---

<p align="center">
  <img src="assets/demo.svg" alt="CLI-Agent Terminal Workspace Mockup" width="100%" />
</p>

---

## ⚡ Overview

When working with CLI-based AI coding agents like **Claude Code** or **GitHub Copilot CLI**, developers often find themselves constantly switching between terminal windows, running `cd /path/to/project`, and remembering custom run commands.

**CLI-Agent** solves this by turning your terminal into an integrated workspace:
- **Truly Independent Sessions**: Each project bookmark runs in its **own isolated terminal session**. Claude Code in Project 1 continues working in the background while you switch to Project 2. No command collisions or `cd` interruptions.
- **Compact & Resizable Sidebar**: Default slim 26-column width. Easily resize on the fly with `<` / `>` keys, `w` width presets, or by dragging the divider with your mouse.
- **Right Pane (Terminal)**: Dedicated, full-fidelity interactive terminal for the active project.
- **Instant Agent Launcher**: Press `c` to launch Claude Code, `p` for Copilot CLI, or `Enter` for your default shell in that project.
- **Real-Time Notification Badges**: Automatically monitors all sessions (active & background) and alerts you when an agent needs input (`? Allow tool`, `(y/n)`), is running, finished, or hit an error.
- **Git Awareness**: Displays live Git branches and uncommitted changes for each project at a glance.
- **Zero External Dependencies**: Built with native Node.js and standard `tmux`. Boots up in under 50ms.

---

## 🚀 Quick Install (One-Liner)

Install CLI-Agent in seconds via your terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/juliendevelopment/cli-agent/main/install.sh | bash
```

### Alternative Installation Methods

<details>
<summary><b>Via GitHub CLI (<code>gh</code>)</b></summary>

```bash
gh api repos/juliendevelopment/cli-agent/contents/install.sh -q .content | base64 -d | bash
```
</details>

<details>
<summary><b>Via Git Clone</b></summary>

```bash
git clone https://github.com/juliendevelopment/cli-agent.git ~/.cli-agent && ~/.cli-agent/install.sh
```
</details>

### Requirements
- **Node.js** (v18.0.0 or higher)
- **tmux** 3.2 or higher (installed by the script if missing on Fedora, Ubuntu, Debian, Arch, or macOS)
- Optional: `wl-copy` (Wayland), `xclip` (X11) or `pbcopy` (macOS) to copy mouse selections to the system clipboard

Run `cli-agent doctor` to check your setup.

---

## 💻 Usage

### Launch the Workspace

Simply run:
```bash
cli-agent
```

---

### Global Shortcuts (Usable Anywhere, Even Inside Terminal)

CLI-Agent runs on its own tmux server (`tmux -L cli-agent`), so these shortcuts only exist inside CLI-Agent: your other tmux sessions and your shell keep their own `Ctrl+E`, `F1`, etc.

| Shortcut | Action |
|---|---|
| **`Ctrl + E`** (or `Alt + E`, configurable with `switcherKey`) | **IntelliJ-Style Quick Switcher Popup**: Shows all sessions with status. The previous session is pre-selected — press `Enter` to instantly toggle between your last 2 sessions! Use `↑`/`↓` to pick any project. |
| **`Alt + ←`** or **`Alt + h`** | **Jump to Sidebar**: Returns keyboard focus from the right terminal back to the left sidebar menu. |
| **`Alt + →`** or **`Alt + l`** | **Jump to Terminal**: Focuses the active terminal pane. |
| **`F1` / `F2`** | Toggle focus between left sidebar (`F1`) and right terminal (`F2`). |
| **`F3`** | Toggle mouse capture on/off (for easy native text selection without Shift). |
| **`Shift` + Drag** | Native host terminal text selection & copy (`Ctrl + Shift + C`). |

---

### Sidebar Shortcuts (When Sidebar is Focused)

| Shortcut | Action |
|---|---|
| `↑` / `↓` or `k` / `j` | Navigate project bookmarks |
| `Enter` | Switch view to selected project's independent terminal |
| `c` | Switch to project & launch **Claude Code** (`claude`) |
| `p` | Switch to project & launch **GitHub Copilot CLI** (`copilot`) |
| `g` / `x` / `n` | Switch to project & launch **Antigravity CLI** (`agy`) / **Codex** / **OpenCode** |
| `s` | Same as `Enter` |
| `Space` / `o` | Open interactive agent selector modal |
| `a` | Add a new bookmark (interactive dialog) |
| `e` | Edit selected bookmark (Name / Path) |
| `d` | Delete selected bookmark & terminate its session |
| `r` | Clear the status badge (live detection takes over again) |
| `<` / `>` or `[` / `]` | **Resize sidebar width** (shrink / expand by 2 cols) |
| `w` | **Cycle width presets** (24, 30, 38 cols) |
| `Tab` | Switch focus directly to the terminal pane |
| `q` | Quit CLI-Agent (closes all sessions, asks for confirmation) |

> Typing `exit` in the right terminal only restarts a fresh shell for the current project; your other sessions keep running.

> 💡 **Mouse Support & Text Selection**:
> - **Hold `Shift` + Drag to Select**: Holding `Shift` while dragging your mouse lets your host terminal emulator select text natively, bypassing tmux mouse capture. Then press `Ctrl + Shift + C` (or Cmd+C on macOS) or right-click to copy.
> - **Auto-Copy on Mouse Release**: Releasing the mouse after dragging text automatically pipes the selection into your system clipboard via OSC 52, `wl-copy`, `xclip`, or `pbcopy`.
> - **Press `F3` to Toggle Mouse Capture**: Press `F3` at any time to turn mouse capture OFF (for regular full-window text selection without Shift), and press `F3` again to turn it back ON for resizing and clicking.

---

## 🚦 Live Statuses & Notifications

CLI-Agent monitors active processes and terminal outputs in real time, displaying colored indicators next to your bookmarks. Install the agent hooks (see below) so statuses come from the agents themselves instead of being guessed from the terminal output.

| Badge | Color | Description / Trigger |
|---|---|---|
| `🔔 ACTION REQUIRED` | 🟡 **Bright Yellow** (highlight) | Triggered when an agent asks a question or requires confirmation (`? Allow tool`, `(y/n)`, `[y/N]`, `Waiting for input`). An alert also appears in the bottom status bar! |
| `⚡ RUNNING...` | 🔵 **Bright Cyan** | The agent is working (`esc to interrupt`, `Thinking…`). |
| `✓ Done` | 🟢 **Green** | The agent has completed its task successfully (`Task complete`, `Done in...`, prompt returned). |
| `✗ ERROR` | 🔴 **Bright Red** | Command error detected (`fatal:`, `Command failed`, `npm ERR!`, uncaught exception). |
| `⏳ RATE LIMIT` | 🟣 **Magenta** | API rate limit or quota warning detected (`Rate limit reached`, `Please wait`). |
| `● Idle` | ⚪ **Gray** | Shell prompt idle and ready for commands. |
| ` main*` | Gray / 🟡 **Yellow `*`** | Git branch name; `*` when there are uncommitted changes. |

### Agent Status Hooks (Recommended)

By default CLI-Agent **guesses** each agent's status by reading its screen (e.g. `esc to interrupt` → running, `1. Yes / 2. No` → waiting for you). That breaks whenever an agent changes its display.

With hooks, the **agent itself tells CLI-Agent** what it is doing: each agent runs `cli-agent notify --hook running|input|done` at the right moment. One command sets it up for every agent installed on your machine:

```bash
cli-agent hooks              # show which agents are found / set up
cli-agent hooks --install    # set up every agent found (or: --install claude,agy)
cli-agent hooks --uninstall  # remove everything CLI-Agent added
```

| Agent | What is installed | ⚡ Running | 🔔 Action required | ✓ Done |
|---|---|---|---|---|
| Claude Code | hooks in `~/.claude/settings.json` | ✅ | ✅ permission / question | ✅ |
| Codex | hooks in `~/.codex/hooks.json` ¹ | ✅ | ✅ permission | ✅ |
| Copilot CLI | `~/.copilot/hooks/cli-agent.json` | ✅ | ✅ permission | ✅ |
| Antigravity CLI (`agy`) | group `cli-agent` in `~/.gemini/config/hooks.json` | ✅ | screen detection ² | ✅ |
| OpenCode | plugin `~/.config/opencode/plugins/cli-agent.js` | ✅ | ✅ permission | ✅ |

¹ Codex skips new hooks until you trust them: run `/hooks` once inside Codex.
² agy has no "permission requested" hook, so that state still comes from the screen.

Restart running agent sessions (and OpenCode's background service) after installing. Files shared with your own settings are backed up once to `<file>.cli-agent.bak`; your own hooks are left untouched.

### Scriptable Notifications

You can also send status notifications programmatically from your own scripts, CI hooks, or background jobs:

```bash
# Target a bookmark by name, index or any path inside the project
cli-agent notify "Backend API" input "Needs permission approval"
cli-agent notify "Backend API" done  "All unit tests passed"
cli-agent notify ~/dev/backend error "Build failed"
cli-agent notify 2 clear

# --quiet: exit 0 silently when no bookmark matches (useful in hooks)
cli-agent notify --quiet "$PWD" done
```

Statuses: `input`, `running`, `done`, `error`, `rate_limit`, `clear`. Manual statuses expire after one hour.

---

## 🛠️ Command-Line Management

Manage your bookmarks directly without entering the interactive UI:

```bash
# Add current directory as a bookmark
cli-agent add "My Project" .

# Add a directory with a custom path and agent
cli-agent add "Web Dashboard" ~/dev/projects/dashboard copilot

# List all saved bookmarks
cli-agent list

# Remove a bookmark by index, name or path
cli-agent remove 2
cli-agent remove "Web Dashboard"

# Check dependencies, config and hooks
cli-agent doctor

# Terminate active CLI-Agent workspace session
cli-agent kill

# Display help and usage
cli-agent help

# Uninstall (add --purge to also delete your bookmarks)
cli-agent uninstall --yes
```

---

## 🔄 Updating CLI-Agent

Keep your installation up to date with a single command:

```bash
cli-agent update
```

This downloads the latest GitHub release (or `main` if no release is published) into `~/.cli-agent/`.  
**Your saved bookmarks in `~/.config/cli-agent/bookmarks.json` are completely preserved and untouched.**

---

## ⚙️ Configuration File

Bookmarks and settings are stored in standard JSON at:
`~/.config/cli-agent/bookmarks.json` (or `$XDG_CONFIG_HOME/cli-agent/`). The file is written atomically; if it ever becomes unreadable, CLI-Agent keeps a copy in `bookmarks.json.corrupt` and never overwrites it.

Example:
```json
{
  "version": 1,
  "selectedIndex": 0,
  "sidebarWidth": 26,
  "switcherKey": "C-e",
  "agents": [
    { "id": "gemini", "name": "Gemini CLI", "command": "gemini", "shortcut": "g" },
    { "id": "claude", "command": "claude --continue" }
  ],
  "bookmarks": [
    {
      "id": "bm_1",
      "name": "Backend API",
      "path": "/home/user/projects/backend-api",
      "agent": "claude",
      "createdAt": "2026-11-12T19:00:00.000Z"
    },
    {
      "id": "bm_2",
      "name": "Web Dashboard",
      "path": "/home/user/projects/dashboard",
      "agent": "copilot",
      "createdAt": "2026-11-12T19:05:00.000Z"
    }
  ]
}
```

- `switcherKey`: tmux key name for the quick switcher (`C-e`, `M-s`, `F5`…). Restart with `cli-agent kill && cli-agent` to apply.
- `agents`: extra agents, or overrides of the built-in ones (`claude`, `copilot`, `agy`, `codex`, `opencode`, `shell`) by `id`. A `shortcut` is a single key; keys used by the sidebar (`a d e j k o q r s w`…) are ignored.

---

## 🧪 Development

```bash
npm test          # node:test, no dependencies
npm run check     # load every module, then run the tests
```

---

## 📄 License

MIT © [Julien](https://github.com/juliendevelopment)
