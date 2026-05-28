import { tool, type PluginInput, type WorkspaceAdapter } from "@opencode-ai/plugin"
import { createOpencodeClient as createV2Client } from "@opencode-ai/sdk/v2"
import { execSync } from "child_process"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"

// Ensure workspace support enabled (must be set before Effect runtime reads it)
if (!process.env.OPENCODE_EXPERIMENTAL_WORKSPACES) {
  process.env.OPENCODE_EXPERIMENTAL_WORKSPACES = "true"
}

// --- State management ---

const STATE_DIR = join(homedir(), ".local", "state", "opencode", "worktree")
const STATUS_FILE = join(STATE_DIR, "status.json")
const SWITCH_DELAY_MS = 0
const SWITCH_CONTINUATION_PROMPT =
  "Worktree switch is complete. Continue the user's latest request in this worktree session. Do not call worktree_switch again."

interface WorktreeEntry {
  branch: string
  path: string
  story?: string
  baseBranch?: string
  createdAt: string
}

interface WorktreeState {
  worktrees: WorktreeEntry[]
}

interface WorktreeSessionSwitch {
  path: string
  sessionID: string
  projectDir: string
  baseUrl: string
  fetch: typeof globalThis.fetch
}

function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true })
}

function loadState(cwd?: string): WorktreeState {
  let state: WorktreeState = { worktrees: [] }
  if (existsSync(STATUS_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(STATUS_FILE, "utf8"))
      state = { worktrees: (parsed.worktrees ?? []).map(toWorktreeEntry) }
    } catch {
      // corrupted — start fresh
    }
  }
  if (cwd) {
    state = syncState(state, cwd)
    saveState(state)
  }
  return state
}

function saveState(state: WorktreeState) {
  ensureStateDir()
  const worktrees = state.worktrees.map(toWorktreeEntry)
  writeFileSync(STATUS_FILE, JSON.stringify({ worktrees }, null, 2), "utf8")
}

function toWorktreeEntry(entry: WorktreeEntry): WorktreeEntry {
  return {
    branch: entry.branch,
    path: entry.path,
    story: entry.story,
    baseBranch: entry.baseBranch,
    createdAt: entry.createdAt,
  }
}

/**
 * Reconcile tracked state with actual git worktrees.
 * Matches by path (immutable), updates branch names from git reality,
 * prunes entries whose worktree path no longer exists in git.
 */
function syncState(state: WorktreeState, cwd: string): WorktreeState {
  let gitWorktrees: Array<{ path: string; branch: string }>
  try {
    gitWorktrees = listGitWorktrees(cwd)
  } catch {
    // Not in a git repo or git unavailable — skip sync
    return state
  }

  const gitByPath = new Map(gitWorktrees.map((wt) => [wt.path, wt.branch]))

  // Update branch names + prune entries with no matching git worktree
  const synced: WorktreeEntry[] = []
  for (const entry of state.worktrees) {
    const gitBranch = gitByPath.get(entry.path)
    if (gitBranch === undefined) {
      // Worktree removed externally — drop from state
      continue
    }
    synced.push(toWorktreeEntry({ ...entry, branch: gitBranch }))
  }

  state.worktrees = synced

  return state
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

function getCurrentWorktreeEntry(state: WorktreeState, directory: string): WorktreeEntry | undefined {
  let currentPath = directory
  try {
    currentPath = getRepoRoot(directory)
  } catch {
    // Keep provided directory if git root cannot be resolved.
  }
  return state.worktrees.find((entry) => entry.path === currentPath)
}

// --- Workspace adapter ---

function createWorktreeWorkspaceAdapter(projectDir: string): WorkspaceAdapter & { list: () => any[] } {
  return {
    name: "Git Worktree",
    description: "Workspace backed by a git worktree in a sibling directory",

    list() {
      // Return all git worktrees so syncList can discover them
      try {
        const repoRoot = getRepoRoot(projectDir)
        const output = execSync("git worktree list --porcelain", { cwd: repoRoot, encoding: "utf-8" })
        const worktrees: any[] = []
        let current: Record<string, string> = {}

        for (const line of output.split("\n")) {
          if (line.startsWith("worktree ")) {
            if (current.directory) {
              worktrees.push(current)
            }
            current = { directory: line.slice(9) }
          } else if (line.startsWith("branch refs/heads/")) {
            current.branch = line.slice(18)
          }
        }
        if (current.directory) worktrees.push(current)

        // Exclude main worktree (the project root itself)
        return worktrees
          .filter((wt) => wt.directory !== repoRoot && wt.branch)
          .map((wt) => ({
            type: "worktree",
            name: wt.branch,
            branch: wt.branch,
            directory: wt.directory,
            extra: null,
          }))
      } catch {
        return []
      }
    },

    async configure(config) {
      if (config.branch) {
        const repoRoot = getRepoRoot(projectDir)
        config.directory = getWorktreeSiblingPath(repoRoot, config.branch)
        config.name = config.branch
      }
      return config
    },

    async create(config, _env, from) {
      if (!config.directory || !config.branch) return
      if (existsSync(config.directory)) return

      const repoRoot = getRepoRoot(projectDir)
      const base = from?.branch || getCurrentBranch(repoRoot)
      mkdirSync(join(config.directory, ".."), { recursive: true })
      git(`worktree add -b ${config.branch} "${config.directory}" ${base}`, repoRoot)
    },

    async remove(config) {
      if (!config.directory || !existsSync(config.directory)) return
      const repoRoot = getRepoRoot(projectDir)
      git(`worktree remove "${config.directory}" --force`, repoRoot)
    },

    target(config) {
      return { type: "local" as const, directory: config.directory! }
    },
  }
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
      const state = loadState(repoRoot)
      state.worktrees.push({
        branch: args.branch,
        path: wtPath,
        story: args.story,
        baseBranch: base,
        createdAt: new Date().toISOString(),
      })
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
    description: "List all worktrees with branch, story reference, and current-session marker.",
    args: {},
    async execute(_args, ctx) {
      ctx.metadata({ title: "worktree: list" })

      const repoRoot = getRepoRoot(projectDir)
      const gitWorktrees = listGitWorktrees(repoRoot)
      const state = loadState(repoRoot)
      const current = getCurrentWorktreeEntry(state, ctx.directory)

      const lines = gitWorktrees.map((wt) => {
        const entry = state.worktrees.find((e) => e.path === wt.path)
        const marker = entry?.path === current?.path ? "→" : " "
        const label = entry?.path === current?.path ? " [current]" : ""
        const story = entry?.story ? ` (${entry.story})` : ""
        return `${marker} ${wt.branch}${story}${label} @ ${wt.path}`
      })

      if (lines.length === 0) return "No worktrees found."
      return [`Current: ${current?.branch || "none"}`, "", ...lines].join("\n")
    },
  })
}

function scheduleWorktreeSessionSwitch(args: WorktreeSessionSwitch) {
  setTimeout(() => {
    switchWorktreeSession(args).catch((error) => console.error("worktree_switch failed", error))
  }, SWITCH_DELAY_MS)
}

async function switchWorktreeSession(args: WorktreeSessionSwitch) {
  const worktreeClient = createV2Client({
    baseUrl: args.baseUrl,
    fetch: args.fetch,
    directory: args.path,
  })

  const originalClient = createV2Client({
    baseUrl: args.baseUrl,
    fetch: args.fetch,
    directory: args.projectDir,
  })

  const abortResult = await originalClient.session.abort({ sessionID: args.sessionID })
  if (abortResult.error) console.error("worktree_switch session abort failed", abortResult.error)

  const forkResult = await worktreeClient.session.fork({ sessionID: args.sessionID })
  if (forkResult.error) throw new Error(`Fork failed: ${JSON.stringify(forkResult.error)}`)

  const newSessionID = forkResult.data.id
  const selectResult = await worktreeClient.tui.selectSession({ sessionID: newSessionID })
  if (selectResult.error) {
    throw new Error(`Session forked but TUI switch failed: ${JSON.stringify(selectResult.error)}; New session ID: ${newSessionID}`)
  }

  const deleteResult = await originalClient.session.delete({ sessionID: args.sessionID })
  if (deleteResult.error) console.error("worktree_switch session cleanup failed", deleteResult.error)

  const promptResult = await worktreeClient.session.prompt({
    sessionID: newSessionID,
    parts: [{ type: "text", text: SWITCH_CONTINUATION_PROMPT, synthetic: true }],
  })
  if (promptResult.error) {
    throw new Error(`Session forked but continuation failed: ${JSON.stringify(promptResult.error)}; New session ID: ${newSessionID}`)
  }
}

function createWorktreeSwitchTool(projectDir: string, inProcessFetch: typeof globalThis.fetch, baseUrl: string) {
  return tool({
    description:
      "Switch current worktree context. " +
      "Forks the current session into a new session rooted in the worktree directory, " +
      "preserving full conversation history. The TUI auto-navigates to the new session.",
    args: {
      branch: tool.schema.string().describe("Branch name of worktree to switch to"),
    },
    async execute(args, ctx) {
      ctx.metadata({ title: `worktree: switch → ${args.branch}` })

      const repoRoot = getRepoRoot(projectDir)
      const state = loadState(repoRoot)
      const entry = state.worktrees.find((e) => e.branch === args.branch)

      if (!entry) {
        const available = state.worktrees.map((e) => e.branch).join(", ")
        return `Worktree '${args.branch}' not found. Available: ${available || "none"}`
      }

      if (!existsSync(entry.path)) {
        return `Worktree path ${entry.path} no longer exists. Remove with worktree_finish.`
      }

      scheduleWorktreeSessionSwitch({
        path: entry.path,
        sessionID: ctx.sessionID,
        projectDir,
        baseUrl,
        fetch: inProcessFetch,
      })

      saveState(state)
      const lines = [
        `Switched to worktree: ${args.branch}`,
        `Path: ${entry.path}`,
        entry.story ? `Story: ${entry.story}` : "",
        `Session switch scheduled. Stop here; continuation resumes in the forked worktree session.`,
      ]
      return lines.filter(Boolean).join("\n")
    },
  })
}

function createWorktreeStatusTool(projectDir: string) {
  return tool({
    description: "Get detailed status of a worktree: branch, dirty files, commits ahead.",
    args: {
      branch: tool.schema
        .string()
        .optional()
        .describe("Branch to check (defaults to current worktree)"),
    },
    async execute(args, ctx) {
      ctx.metadata({ title: "worktree: status" })

      const repoRoot = getRepoRoot(projectDir)
      const state = loadState(repoRoot)
      const current = getCurrentWorktreeEntry(state, ctx.directory)
      const targetBranch = args.branch || current?.branch

      if (!targetBranch) return "No current worktree. Pass branch, or use worktree_switch."

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
        .describe("Branch to finish (defaults to current worktree)"),
      force: tool.schema
        .boolean()
        .optional()
        .describe("Force removal even with uncommitted changes"),
    },
    async execute(args, ctx) {
      ctx.metadata({ title: `worktree: finish ${args.branch || "current"}` })

      const repoRoot = getRepoRoot(projectDir)
      const state = loadState(repoRoot)
      const current = getCurrentWorktreeEntry(state, ctx.directory)
      const targetBranch = args.branch || current?.branch

      if (!targetBranch) return "No current worktree to finish. Pass branch to finish a tracked worktree."

      const entry = state.worktrees.find((e) => e.branch === targetBranch)
      if (!entry) return `Worktree '${targetBranch}' not tracked.`

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
      saveState(state)

      return `Worktree '${targetBranch}' removed. Branch still exists for merge/PR.`
    },
  })
}

// --- Plugin export ---

const WorktreeManagerPlugin = async (input: PluginInput) => {
  const { client, directory: projectDir, experimental_workspace } = input

  // Register workspace adapter — includes list() for syncList discovery
  experimental_workspace.register("worktree", createWorktreeWorkspaceAdapter(projectDir) as any)

  // Extract in-process fetch from V1 client (opencode injects Server.Default().app.fetch)
  const v1Internal = (client as any)._client ?? (client as any).client
  const v1Config = v1Internal?.getConfig?.() ?? {}
  const inProcessFetch = v1Config.fetch ?? globalThis.fetch
  const baseUrl = v1Config.baseUrl ?? "http://localhost:4096"

  return {
    config: async (cfg: any) => {
      cfg.experimental = cfg.experimental || {}
      if (cfg.experimental.workspaces === undefined) {
        cfg.experimental.workspaces = true
      }
    },

    tool: {
      worktree_create: createWorktreeCreateTool(projectDir),
      worktree_list: createWorktreeListTool(projectDir),
      worktree_switch: createWorktreeSwitchTool(projectDir, inProcessFetch, baseUrl),
      worktree_status: createWorktreeStatusTool(projectDir),
      worktree_finish: createWorktreeFinishTool(projectDir),
    },
  }
}

export { WorktreeManagerPlugin }
export default WorktreeManagerPlugin
