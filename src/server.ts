import { tool } from "@opencode-ai/plugin"
import { execSync } from "child_process"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"

// --- State management ---

const STATE_DIR = join(homedir(), ".local", "state", "opencode", "worktree")
const STATUS_FILE = join(STATE_DIR, "status.json")

interface WorktreeEntry {
  branch: string
  path: string
  status: "active" | "idle"
  story?: string
  baseBranch?: string
  createdAt: string
}

interface WorktreeState {
  active?: string
  worktrees: WorktreeEntry[]
}

function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true })
}

function loadState(): WorktreeState {
  if (!existsSync(STATUS_FILE)) return { worktrees: [] }
  try {
    return JSON.parse(readFileSync(STATUS_FILE, "utf8"))
  } catch {
    return { worktrees: [] }
  }
}

function saveState(state: WorktreeState) {
  ensureStateDir()
  writeFileSync(STATUS_FILE, JSON.stringify(state, null, 2), "utf8")
}

// --- Git helpers ---

function git(args: string, cwd?: string): string {
  try {
    return execSync(`git ${args}`, {
      cwd,
      encoding: "utf8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
  } catch (err: any) {
    throw new Error(`git ${args} failed: ${err.message}`)
  }
}

function getRepoRoot(cwd: string): string {
  return git("rev-parse --show-toplevel", cwd)
}

function getCurrentBranch(cwd: string): string {
  return git("rev-parse --abbrev-ref HEAD", cwd)
}

function getWorktreeSiblingPath(repoRoot: string, branch: string): string {
  const repoName = repoRoot.split("/").pop()!
  const parentDir = join(repoRoot, "..")
  return join(parentDir, `${repoName}-worktrees`, branch)
}

function listGitWorktrees(cwd: string): Array<{ path: string; branch: string }> {
  const output = git("worktree list --porcelain", cwd)
  const entries: Array<{ path: string; branch: string }> = []
  let currentPath = ""

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length)
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length)
      const branch = ref.replace("refs/heads/", "")
      entries.push({ path: currentPath, branch })
    }
  }
  return entries
}

// --- Tools ---

function createWorktreeCreateTool(projectDir: string) {
  return tool({
    description:
      "Create a new git worktree for isolated development. " +
      "Creates branch + worktree in sibling directory. " +
      "Returns the worktree path for subsequent operations.",
    args: {
      branch: tool.schema.string().describe("Branch name to create (e.g. feature/dark-mode)"),
      baseBranch: tool.schema.string().optional().describe("Base branch (defaults to current HEAD)"),
      story: tool.schema.string().optional().describe("Story/ticket reference (e.g. #256, PROJ-123)"),
    },
    async execute(args, ctx) {
      ctx.metadata({ title: `worktree: create ${args.branch}` })

      const repoRoot = getRepoRoot(projectDir)
      const base = args.baseBranch || getCurrentBranch(repoRoot)
      const wtPath = getWorktreeSiblingPath(repoRoot, args.branch)

      if (existsSync(wtPath)) {
        return `Worktree already exists at ${wtPath}. Use worktree_switch to activate it.`
      }

      // Create worktree with new branch
      mkdirSync(join(wtPath, ".."), { recursive: true })
      git(`worktree add -b ${args.branch} "${wtPath}" ${base}`, repoRoot)

      // Update state
      const state = loadState()
      state.worktrees.push({
        branch: args.branch,
        path: wtPath,
        status: "idle",
        story: args.story,
        baseBranch: base,
        createdAt: new Date().toISOString(),
      })
      state.active = args.branch
      saveState(state)

      return [
        `Worktree created:`,
        `  Branch: ${args.branch}`,
        `  Path: ${wtPath}`,
        `  Base: ${base}`,
        args.story ? `  Story: ${args.story}` : "",
        ``,
        `Use workdir="${wtPath}" in Bash tool calls to operate in this worktree.`,
      ]
        .filter(Boolean)
        .join("\n")
    },
  })
}

function createWorktreeListTool(projectDir: string) {
  return tool({
    description: "List all active worktrees with their status, branch, and story reference.",
    args: {},
    async execute(_args, ctx) {
      ctx.metadata({ title: "worktree: list" })

      const repoRoot = getRepoRoot(projectDir)
      const gitWorktrees = listGitWorktrees(repoRoot)
      const state = loadState()

      const lines = gitWorktrees.map((wt) => {
        const entry = state.worktrees.find((e) => e.branch === wt.branch)
        const isActive = state.active === wt.branch
        const marker = isActive ? "→" : " "
        const status = entry?.status || "unknown"
        const story = entry?.story ? ` (${entry.story})` : ""
        return `${marker} ${wt.branch}${story} [${status}] @ ${wt.path}`
      })

      if (lines.length === 0) return "No worktrees found."
      return [`Active: ${state.active || "none"}`, "", ...lines].join("\n")
    },
  })
}

function createWorktreeSwitchTool(projectDir: string) {
  return tool({
    description:
      "Switch active worktree context. " +
      "After switching, use the returned path as workdir for Bash tool calls.",
    args: {
      branch: tool.schema.string().describe("Branch name of worktree to switch to"),
    },
    async execute(args, ctx) {
      ctx.metadata({ title: `worktree: switch → ${args.branch}` })

      const state = loadState()
      const entry = state.worktrees.find((e) => e.branch === args.branch)

      if (!entry) {
        const available = state.worktrees.map((e) => e.branch).join(", ")
        return `Worktree '${args.branch}' not found. Available: ${available || "none"}`
      }

      if (!existsSync(entry.path)) {
        return `Worktree path ${entry.path} no longer exists. Remove with worktree_finish.`
      }

      // Mark previous as idle, new as active
      for (const wt of state.worktrees) {
        if (wt.branch === state.active) wt.status = "idle"
      }
      entry.status = "active"
      state.active = args.branch
      saveState(state)

      return [
        `Switched to worktree: ${args.branch}`,
        `Path: ${entry.path}`,
        entry.story ? `Story: ${entry.story}` : "",
        ``,
        `Use workdir="${entry.path}" in Bash tool calls.`,
      ]
        .filter(Boolean)
        .join("\n")
    },
  })
}

function createWorktreeStatusTool(projectDir: string) {
  return tool({
    description: "Get detailed status of active worktree: branch, dirty files, commits ahead.",
    args: {
      branch: tool.schema
        .string()
        .optional()
        .describe("Branch to check (defaults to active worktree)"),
    },
    async execute(args, ctx) {
      ctx.metadata({ title: "worktree: status" })

      const state = loadState()
      const targetBranch = args.branch || state.active

      if (!targetBranch) return "No active worktree. Use worktree_create or worktree_switch."

      const entry = state.worktrees.find((e) => e.branch === targetBranch)
      if (!entry) return `Worktree '${targetBranch}' not tracked.`
      if (!existsSync(entry.path)) return `Path ${entry.path} missing.`

      const status = git("status --porcelain", entry.path)
      const ahead = git(
        `rev-list --count ${entry.baseBranch || "HEAD"}..${targetBranch}`,
        entry.path,
      ).trim()

      const dirty = status ? status.split("\n").length : 0

      return [
        `Worktree: ${targetBranch}`,
        `Path: ${entry.path}`,
        entry.story ? `Story: ${entry.story}` : "",
        `Base: ${entry.baseBranch || "unknown"}`,
        `Commits ahead: ${ahead}`,
        `Dirty files: ${dirty}`,
        dirty > 0 ? `\n${status}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    },
  })
}

function createWorktreeFinishTool(projectDir: string) {
  return tool({
    description:
      "Finish and remove a worktree. " +
      "Does NOT auto-commit — commit manually before calling this. " +
      "Removes git worktree and cleans state.",
    args: {
      branch: tool.schema
        .string()
        .optional()
        .describe("Branch to finish (defaults to active worktree)"),
      force: tool.schema
        .boolean()
        .optional()
        .describe("Force removal even with uncommitted changes"),
    },
    async execute(args, ctx) {
      ctx.metadata({ title: `worktree: finish ${args.branch || "active"}` })

      const state = loadState()
      const targetBranch = args.branch || state.active

      if (!targetBranch) return "No active worktree to finish."

      const entry = state.worktrees.find((e) => e.branch === targetBranch)
      if (!entry) return `Worktree '${targetBranch}' not tracked.`

      const repoRoot = getRepoRoot(projectDir)

      // Check for uncommitted changes
      if (existsSync(entry.path)) {
        const status = git("status --porcelain", entry.path)
        if (status && !args.force) {
          return [
            `Worktree has uncommitted changes:`,
            status,
            ``,
            `Commit first, or use force: true to discard.`,
          ].join("\n")
        }

        // Remove git worktree
        const forceFlag = args.force ? " --force" : ""
        git(`worktree remove "${entry.path}"${forceFlag}`, repoRoot)
      }

      // Update state
      state.worktrees = state.worktrees.filter((e) => e.branch !== targetBranch)
      if (state.active === targetBranch) {
        state.active = state.worktrees[0]?.branch
      }
      saveState(state)

      return `Worktree '${targetBranch}' removed. Branch still exists for merge/PR.`
    },
  })
}

// --- Plugin export ---

const WorktreeManagerPlugin = async (input: any) => {
  const projectDir = input.directory

  return {
    tool: {
      worktree_create: createWorktreeCreateTool(projectDir),
      worktree_list: createWorktreeListTool(projectDir),
      worktree_switch: createWorktreeSwitchTool(projectDir),
      worktree_status: createWorktreeStatusTool(projectDir),
      worktree_finish: createWorktreeFinishTool(projectDir),
    },

    "experimental.chat.system.transform": async (_input: any, output: any) => {
      const state = loadState()
      if (!state.active) return

      const entry = state.worktrees.find((e) => e.branch === state.active)
      if (!entry) return

      const lines = [
        `<system-reminder>`,
        `ACTIVE WORKTREE: ${entry.branch}${entry.story ? ` (${entry.story})` : ""}`,
        `Path: ${entry.path}`,
        `Use workdir="${entry.path}" for all Bash operations in this worktree.`,
        `When reporting status or results, mention you are working in worktree "${entry.branch}".`,
        `</system-reminder>`,
      ]

      output.system.push(lines.join("\n"))
    },
  }
}

export { WorktreeManagerPlugin }
export default WorktreeManagerPlugin
