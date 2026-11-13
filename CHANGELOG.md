# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- Bookmarks can no longer be lost: the config is written atomically, and an unreadable `bookmarks.json` is backed up to `bookmarks.json.corrupt` instead of being overwritten.
- Typing `exit` in the right terminal recreates a shell instead of killing every session.
- `r` in the sidebar and `cli-agent notify … clear` really clear the status (they used to freeze it on "Idle"). Manual statuses now expire after 1 hour.
- `cli-agent remove "Name"` finds bookmarks by name, index, id or path.
- Mouse clicks select the right bookmark when the alert line is shown or the list is scrolled.
- Pasting text into the add / edit fields works.
- Deleting the active bookmark switches to another one before closing its terminal.
- Paths containing `"`, `$` or backquotes no longer break tmux commands (no shell is used anymore).

### Changed
- The tmux status line is now at the top and doubles as the tab bar. The terminal window/tab title is "CLI-Agent · <bookmark>" instead of "node". Terminals are tracked by tmux pane (tagged with their bookmark) instead of by hidden window names.
- CLI-Agent runs on a dedicated tmux server (`tmux -L cli-agent`): its key bindings (Ctrl+E, F1–F3, Alt+arrows), mouse and clipboard settings no longer affect your other tmux sessions. Leftover bindings from older versions are removed from the default server.
- Status monitoring uses one `tmux list-panes` call per tick and asynchronous `git status`, so the sidebar stays responsive with many projects. The git branch is shown next to each project.
- Stricter "running" detection (`esc to interrupt`, `Thinking…`) and no screen flicker on redraw.
- The installer no longer runs `sudo` to install clipboard tools, warns when tmux < 3.2, and downloads the latest release.
- All UI messages are in English.

### Added
- Tabs: several terminals per bookmark (e.g. Claude Code in one, a shell in another). A tab bar at the top shows the active bookmark's tabs with their status; `Ctrl+T` (`newTabKey`) or the `+` button opens a tab in the bookmark's directory, `Alt+1…9`, `Ctrl+PgUp/PgDn` or a click switches tabs, `exit` closes one, `t` in the sidebar opens a tab for the selected bookmark. The sidebar shows the tab count (`⧉2`) and the most urgent status of all tabs.
- `cli-agent hooks [--install|--uninstall] [agents]`: Claude Code, Codex, Copilot CLI, Antigravity CLI (agy) and OpenCode report their own status (running / action required / done) through `cli-agent notify --hook`.
- Short alias `ca` to launch CLI-Agent (created by the installer, `update`, or on first launch; never replaces an existing `ca`).
- Built-in agents: Antigravity CLI (`g`), Codex (`x`), OpenCode (`n`).
- `cli-agent notify` accepts a path, `--quiet`, and `--hook` (bookmark found from the tmux pane or the agent's JSON payload).
- Configurable agents (`agents` in the config) and switcher key (`switcherKey`).
- `cli-agent doctor`, `cli-agent uninstall`, `cli-agent version` / `--version`.
- Tests (`npm test`, `node:test`, no dependencies) and GitHub Actions CI.

## [1.0.0]

- Initial release.
