# Agent Instructions

## Worktree Source Of Truth

- Git is authoritative for worktree existence, paths, and branches.
- OpenCode `worktree.list()` is authoritative for TUI-visible available worktrees because it is Git-backed.
- OpenCode workspace list is not a complete source for available Git worktrees.
- Session/workspace path is authoritative for current worktree detection.
- Do not persist plugin worktree state files such as `status.json`.
- Do not cache `story`, `baseBranch`, `createdAt`, or other metadata unless a user-facing feature cannot be derived from Git/OpenCode.
- Server tools must derive worktrees from `git worktree list --porcelain`.
- TUI code must derive available worktrees from `worktree.list()`; workspace list may be fallback only.
- If metadata is needed, compute it at command time or return it only in command output.

## Worktree Switching

- Use session fork into the target worktree directory for switching.
- Do not use `experimental.workspace.warp()` for worktree switching.
- Warp-to-worktree has been tried repeatedly and is not feasible with current OpenCode behavior.
- A valid switch flow creates/selects a forked session whose directory is the target git worktree.
- OpenCode `session.fork` routes by source session directory; correct forked session `directory`, `path`, and `workspace_id` before selecting it.
