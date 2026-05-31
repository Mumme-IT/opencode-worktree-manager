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
| `worktree_list` | List Git worktrees with current marker |
| `worktree_switch` | Switch active worktree context |
| `worktree_status` | Dirty files and commits ahead |
| `worktree_finish` | Remove worktree (no auto-commit) |

## Features

- **TUI sidebar** — shows active worktrees from Git-backed `worktree.list()`
- **System prompt injection** — agent always knows which worktree is active
- **Source of truth** — Git worktrees + OpenCode session paths, no plugin state file
- **No forced auto-commit** — you control when to commit

## Development

```bash
bun install
bun run build
```
