# opencode-worktree-manager

Git worktree management plugin for OpenCode with TUI sidebar status panel.

## Install

```bash
npm install opencode-worktree-manager
```

### Server plugin

`opencode.json`:

```json
{
  "plugin": ["opencode-worktree-manager"]
}
```

### TUI plugin

`tui.json`:

```json
{
  "plugin": ["opencode-worktree-manager"]
}
```

## Tools

| Tool | Description |
|------|-------------|
| `worktree_create` | Create worktree + branch in sibling dir |
| `worktree_list` | List all tracked worktrees with status |
| `worktree_switch` | Switch active worktree context |
| `worktree_status` | Dirty files, commits ahead, story ref |
| `worktree_finish` | Remove worktree (no auto-commit) |

## Features

- **TUI sidebar** — shows active worktrees with branch, story, status
- **System prompt injection** — agent always knows which worktree is active
- **State file** — `~/.local/state/opencode/worktree/status.json`
- **No forced auto-commit** — you control when to commit

## Development

```bash
bun install
bun run build
```
