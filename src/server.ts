import { tool, type PluginInput } from "@opencode-ai/plugin"
import { createOpencodeClient as createV2Client } from "@opencode-ai/sdk/v2"
import { execFileSync, execSync } from "child_process"
import { existsSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"

// --- Constants ---

const SWITCH_CONTINUATION_PROMPT =
  "Worktree switch is complete. Continue the user's latest request in this worktree session. Do not call worktree_switch again."
const FINISH_CONTINUATION_PROMPT =
  "Worktree finalize is complete. Continue the user's latest request in the main project session. Do not call worktree_finish again."
const ROOT_SWITCH_REQUIRED_MESSAGE =
  "Worktree switch blocked: only the root agent can switch worktrees. Ask the root agent to switch before starting subagents for work in this worktree."
const TOOL_COMPLETION_POLL_MS = 5
const TOOL_COMPLETION_TIMEOUT_MS = 2000
const OPENCODE_DB_FILE = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "opencode.db")
const WORKTREE_TOOL_INSTRUCTIONS = [
  "Worktree operations:",
  "- MUST use plugin tools for normal worktree operations: worktree_create, worktree_list, worktree_switch, worktree_status, worktree_finish.",
  "- MUST NOT run direct `git worktree add/remove/move/prune/repair/lock/unlock` when a plugin tool can perform the operation.",
  "- Direct `git worktree` modification commands are allowed only when plugin tool capabilities are insufficient for the required operation.",
  "- Before any allowed direct `git worktree` modification, state why plugin tools are insufficient.",
  "- Read-only Git inspection is allowed when plugin output is insufficient for diagnosis.",
].join("\n")

interface WorktreeEntry {
  branch: string
  path: string
}

interface WorktreeSessionSwitch {
  branch: string
  path: string
  sessionID: string
  messageID: string
  toolName: string
  projectRoot: string
  baseUrl: string
  fetch: typeof globalThis.fetch
  prompt?: string
}

interface SessionInfo {
  id: string
  parentID?: string
  title: string
  agent?: string
  model?: {
    id: string
    providerID: string
    variant?: string
  }
}

interface ContinuationPromptOptions {
  agent?: string
  model?: {
    providerID: string
    modelID: string
  }
  variant?: string
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

function getMainWorktreeRoot(cwd: string): string {
  return listGitWorktrees(cwd)[0]?.path ?? getRepoRoot(cwd)
}

function getCurrentBranch(cwd: string): string {
  return git("rev-parse --abbrev-ref HEAD", cwd)
}

function getWorktreeSiblingPath(repoRoot: string, branch: string): string {
  return join(getDefaultWorktreeContainer(repoRoot), branch)
}

function getDefaultWorktreeContainer(repoRoot: string): string {
  const repoName = repoRoot.split("/").pop()!
  const parentDir = join(repoRoot, "..")
  return join(parentDir, `${repoName}-worktrees`)
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function branchExists(cwd: string, branch: string): boolean {
  try {
    git(`show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}`, cwd)
    return true
  } catch {
    return false
  }
}

function findCheckedOutBranch(cwd: string, branch: string): { path: string; branch: string } | undefined {
  return listGitWorktrees(cwd).find((worktree) => worktree.branch === branch)
}

function addWorktree(repoRoot: string, branch: string, worktreePath: string, base?: string): void {
  mkdirSync(join(worktreePath, ".."), { recursive: true })
  if (branchExists(repoRoot, branch)) {
    const checkedOut = findCheckedOutBranch(repoRoot, branch)
    if (checkedOut) {
      throw new Error(`Branch '${branch}' is already checked out at ${checkedOut.path}.`)
    }
    git(`worktree add ${shellQuote(worktreePath)} ${shellQuote(branch)}`, repoRoot)
    return
  }

  git(`worktree add -b ${shellQuote(branch)} ${shellQuote(worktreePath)} ${shellQuote(base ?? "HEAD")}`, repoRoot)
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

function getCurrentWorktreePath(directory: string): string {
  let currentPath = directory
  try {
    currentPath = getRepoRoot(directory)
  } catch {
    // Keep provided directory if git root cannot be resolved.
  }
  return currentPath
}

function getLinkedGitWorktrees(cwd: string): WorktreeEntry[] {
  const mainWorktreeRoot = getMainWorktreeRoot(cwd)
  return listGitWorktrees(cwd).filter((worktree) => worktree.path !== mainWorktreeRoot)
}

function findGitWorktreeByBranch(cwd: string, branch: string): WorktreeEntry | undefined {
  return getLinkedGitWorktrees(cwd).find((worktree) => worktree.branch === branch)
}

function getCurrentLinkedWorktree(cwd: string, directory: string): WorktreeEntry | undefined {
  const currentPath = getCurrentWorktreePath(directory)
  return getLinkedGitWorktrees(cwd).find((entry) => entry.path === currentPath)
}

function resolveStatusBaseRef(cwd: string): string | undefined {
  for (const ref of ["@{upstream}", "main", "master"]) {
    try {
      git(`rev-parse --verify --quiet ${shellQuote(ref)}`, cwd)
      return ref
    } catch {
      // Try next common base ref.
    }
  }
  return undefined
}

function sqliteQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function updateSessionLocation(sessionID: string, directory: string): void {
  if (!existsSync(OPENCODE_DB_FILE)) throw new Error(`OpenCode database not found: ${OPENCODE_DB_FILE}`)
  const sql = [
    "UPDATE session SET",
    `directory = ${sqliteQuote(directory)},`,
    `path = ${sqliteQuote("")}`,
    `WHERE id = ${sqliteQuote(sessionID)}`,
  ].join(" ")
  execFileSync("sqlite3", [OPENCODE_DB_FILE, sql], { stdio: ["ignore", "pipe", "pipe"] })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

// --- Tools ---

function createWorktreeCreateTool(projectDir: string, inProcessFetch: typeof globalThis.fetch, baseUrl: string) {
  return tool({
    description:
      "Create a new git worktree for isolated development. " +
      "Creates branch + worktree in sibling directory. " +
      "Switches to the new worktree by default unless switch is false. " +
      "Returns the worktree path for subsequent operations. " +
      "Root agent only: switch worktrees before starting subagents that must work there. " +
      "Subagents must not switch worktrees; they must ask the root agent to switch first.",
    args: {
      branch: tool.schema.string().describe("Branch name to create (e.g. feature/dark-mode)"),
      baseBranch: tool.schema.string().optional().describe("Base branch (defaults to current HEAD)"),
      switch: tool.schema.boolean().optional().describe("Switch to the new worktree after creating it (defaults to true)"),
    },
    async execute(args, ctx) {
      ctx.metadata({ title: `worktree: create ${args.branch}` })

      const repoRoot = getMainWorktreeRoot(projectDir)
      const base = args.baseBranch || getCurrentBranch(repoRoot)
      const wtPath = getWorktreeSiblingPath(repoRoot, args.branch)
      const shouldSwitch = args.switch !== false

      if (shouldSwitch && !(await canSwitchFromSession(baseUrl, inProcessFetch, projectDir, ctx.sessionID))) {
        return ROOT_SWITCH_REQUIRED_MESSAGE
      }

      if (existsSync(wtPath)) {
        return `Worktree already exists at ${wtPath}. Use worktree_switch to activate it.`
      }

      try {
        addWorktree(repoRoot, args.branch, wtPath, base)
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }

      if (shouldSwitch) {
        scheduleWorktreeSessionSwitch({
          branch: args.branch,
          path: wtPath,
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          toolName: "worktree_create",
          projectRoot: repoRoot,
          baseUrl,
          fetch: inProcessFetch,
        })
      }

      return [
        `Worktree created:`,
        `  Branch: ${args.branch}`,
        `  Path: ${wtPath}`,
        `  Base: ${base}`,
        ``,
        shouldSwitch
          ? `Session switched to worktree session. Stop here; continuation resumes in the worktree session.`
          : `Use workdir="${wtPath}" in Bash tool calls to operate in this worktree.`,
      ]
        .filter(Boolean)
        .join("\n")
    },
  })
}

function createWorktreeListTool(projectDir: string) {
  return tool({
    description:
      "List git worktrees with branch and current-session marker. " +
      "Use this before removing worktrees; do not infer current/non-current from git status or cwd alone.",
    args: {},
    async execute(_args, ctx) {
      ctx.metadata({ title: "worktree: list" })

      const repoRoot = getMainWorktreeRoot(projectDir)
      const gitWorktrees = listGitWorktrees(repoRoot)
      const currentPath = getCurrentWorktreePath(ctx.directory)

      const lines = gitWorktrees.map((wt) => {
        const isCurrent = wt.path === currentPath
        const marker = isCurrent ? "→" : " "
        const label = isCurrent ? " [current]" : ""
        return `${marker} ${wt.branch}${label} @ ${wt.path}`
      })

      if (lines.length === 0) return "No worktrees found."
      const current = gitWorktrees.find((wt) => wt.path === currentPath)
      return [`Current: ${current?.branch || "none"}`, "", ...lines].join("\n")
    },
  })
}

async function canSwitchFromSession(baseUrl: string, fetch: typeof globalThis.fetch, projectDir: string, sessionID: string) {
  const client = createV2Client({ baseUrl, fetch, directory: getMainWorktreeRoot(projectDir) })
  const result = await client.session.get({ sessionID })
  if (result.error) throw new Error(`Session lookup failed: ${JSON.stringify(result.error)}`)
  return !(result.data as SessionInfo).parentID
}

async function switchWorktreeSession(args: WorktreeSessionSwitch) {
  const projectRoot = args.projectRoot
  const originalClient = createV2Client({
    baseUrl: args.baseUrl,
    fetch: args.fetch,
    directory: projectRoot,
  })
  const worktreeClient = createV2Client({
    baseUrl: args.baseUrl,
    fetch: args.fetch,
    directory: args.path,
  })

  const originalSessionResult = await originalClient.session.get({ sessionID: args.sessionID, directory: projectRoot })
  const sourceSession = originalSessionResult.error ? undefined : (originalSessionResult.data as SessionInfo)

  await waitForToolCompletion(originalClient, args, projectRoot)

  const interruptResult = await originalClient.session.abort({ sessionID: args.sessionID, directory: projectRoot })
  if (interruptResult.error) throw new Error(`Session interrupt failed: ${JSON.stringify(interruptResult.error)}`)

  const forkResult = await worktreeClient.session.fork({ sessionID: args.sessionID, directory: args.path })
  if (forkResult.error) throw new Error(`Fork failed: ${JSON.stringify(forkResult.error)}`)

  const newSessionID = forkResult.data.id
  if (sourceSession) {
    const title = getWorktreeSessionTitle(args.branch, sourceSession.title)
    const updateResult = await worktreeClient.session.update({ sessionID: newSessionID, directory: args.path, title })
    if (updateResult.error) console.error("worktree_switch session title update failed", updateResult.error)
  }
  updateSessionLocation(newSessionID, args.path)

  const selectResult = await originalClient.tui.selectSession({ sessionID: newSessionID, directory: projectRoot })
  if (selectResult.error) {
    throw new Error(`Session forked but TUI switch failed: ${JSON.stringify(selectResult.error)}; New session ID: ${newSessionID}`)
  }

  const promptResult = await worktreeClient.session.promptAsync({
    sessionID: newSessionID,
    directory: args.path,
    ...getContinuationPromptOptions(sourceSession),
    parts: [{ type: "text", text: args.prompt ?? SWITCH_CONTINUATION_PROMPT, synthetic: true }],
  })
  if (promptResult.error) {
    throw new Error(`Session forked but continuation failed: ${JSON.stringify(promptResult.error)}; New session ID: ${newSessionID}`)
  }
}

async function waitForToolCompletion(
  client: ReturnType<typeof createV2Client>,
  args: WorktreeSessionSwitch,
  projectRoot: string,
): Promise<void> {
  const deadline = Date.now() + TOOL_COMPLETION_TIMEOUT_MS

  while (Date.now() < deadline) {
    const result = await client.session.message({
      sessionID: args.sessionID,
      messageID: args.messageID,
      directory: projectRoot,
    })
    if (result.error) throw new Error(`Tool completion lookup failed: ${JSON.stringify(result.error)}`)

    const part = [...result.data.parts]
      .reverse()
      .find((candidate) => candidate.type === "tool" && candidate.tool === args.toolName)

    if (part?.type === "tool" && part.state.status === "completed") return
    if (part?.type === "tool" && part.state.status === "error") {
      throw new Error(`${args.toolName} failed before session handoff: ${part.state.error}`)
    }

    await delay(TOOL_COMPLETION_POLL_MS)
  }

  throw new Error(`Timed out waiting for ${args.toolName} to complete before session handoff`)
}

function scheduleWorktreeSessionSwitch(args: WorktreeSessionSwitch): void {
  void switchWorktreeSession(args).catch(async (error) => {
    const message = getErrorMessage(error)
    console.error("worktree session handoff failed", message)

    try {
      const client = createV2Client({
        baseUrl: args.baseUrl,
        fetch: args.fetch,
        directory: args.projectRoot,
      })
      const result = await client.tui.showToast({
        title: "Worktree switch failed",
        message,
        variant: "error",
        duration: 8000,
      })
      if (result.error) console.error("worktree switch failure toast failed", result.error)
    } catch (toastError) {
      console.error("worktree switch failure toast failed", toastError)
    }
  })
}

function getContinuationPromptOptions(session: SessionInfo | undefined): ContinuationPromptOptions {
  if (!session) return {}

  return {
    ...(session.agent ? { agent: session.agent } : {}),
    ...(session.model ? { model: { providerID: session.model.providerID, modelID: session.model.id } } : {}),
    ...(session.model?.variant ? { variant: session.model.variant } : {}),
  }
}

function getWorktreeSessionTitle(branch: string, title: string): string {
  const baseTitle = title.replace(/\s+\(Fork #\d+\)$/, "")
  return `[${branch}] ${baseTitle}`
}

function createWorktreeSwitchTool(projectDir: string, inProcessFetch: typeof globalThis.fetch, baseUrl: string) {
  return tool({
    description:
      "Switch current worktree context. " +
      "Forks the current session into a new session rooted in the worktree directory, " +
      "preserving full conversation history. The TUI auto-navigates to the new session. " +
      "Root agent only: switch worktrees before starting subagents that must work there. " +
      "Subagents must not switch worktrees; they must ask the root agent to switch first.",
    args: {
      branch: tool.schema.string().describe("Branch name of worktree to switch to"),
    },
    async execute(args, ctx) {
      ctx.metadata({ title: `worktree: switch → ${args.branch}` })

      const repoRoot = getMainWorktreeRoot(projectDir)
      let entry = findGitWorktreeByBranch(repoRoot, args.branch)

      if (!(await canSwitchFromSession(baseUrl, inProcessFetch, projectDir, ctx.sessionID))) {
        return ROOT_SWITCH_REQUIRED_MESSAGE
      }

      if (!entry) {
        if (!branchExists(repoRoot, args.branch)) {
          const available = getLinkedGitWorktrees(repoRoot).map((worktree) => worktree.branch).join(", ")
          return `Worktree '${args.branch}' not found. Available: ${available || "none"}`
        }

        const wtPath = getWorktreeSiblingPath(repoRoot, args.branch)
        if (existsSync(wtPath)) return `Worktree path ${wtPath} already exists.`

        try {
          addWorktree(repoRoot, args.branch, wtPath)
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
        entry = { branch: args.branch, path: wtPath }
      }

      if (!existsSync(entry.path)) {
        try {
          addWorktree(repoRoot, args.branch, entry.path)
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      }

      scheduleWorktreeSessionSwitch({
        branch: args.branch,
        path: entry.path,
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        toolName: "worktree_switch",
        projectRoot: repoRoot,
        baseUrl,
        fetch: inProcessFetch,
      })

      const lines = [
        `Switched to worktree: ${args.branch}`,
        `Path: ${entry.path}`,
        `Session switched to worktree session. Stop here; continuation resumes in the worktree session.`,
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

      const repoRoot = getMainWorktreeRoot(projectDir)
      const current = getCurrentLinkedWorktree(repoRoot, ctx.directory)
      const targetBranch = args.branch || current?.branch || getCurrentBranch(ctx.directory)

      if (!targetBranch) return "No current branch. Pass branch, or use worktree_switch."

      const entry = findGitWorktreeByBranch(repoRoot, targetBranch) ?? listGitWorktrees(repoRoot).find((e) => e.branch === targetBranch)
      if (!entry) return `Worktree '${targetBranch}' not found.`
      if (!existsSync(entry.path)) return `Path ${entry.path} missing.`

      const status = git("status --porcelain", entry.path)
      const baseRef = resolveStatusBaseRef(entry.path)
      const ahead = baseRef ? git(`rev-list --count ${shellQuote(`${baseRef}..${targetBranch}`)}`, entry.path).trim() : "unknown"
      const dirty = status ? status.split("\n").length : 0

      return [
        `Worktree: ${targetBranch}`,
        `Path: ${entry.path}`,
        `Base: ${baseRef || "unknown"}`,
        `Commits ahead: ${ahead}`,
        `Dirty files: ${dirty}`,
        dirty > 0 ? `\n${status}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    },
  })
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function createWorktreeFinishTool(projectDir: string, inProcessFetch: typeof globalThis.fetch, baseUrl: string) {
  return tool({
    description:
      "Finish and remove a worktree. " +
      "Does NOT auto-commit — commit manually before calling this. " +
      "Removes git worktree. " +
      "Use this instead of Bash git worktree remove/rm. " +
      "For bulk cleanup, call worktree_list first, then call worktree_finish once per branch. " +
      "Do not use force unless the user explicitly allows discarding changes.",
    args: {
      branch: tool.schema
        .string()
        .optional()
        .describe("Branch to finish (defaults to current worktree)"),
      force: tool.schema
        .boolean()
        .optional()
        .describe("Discard uncommitted changes during removal; only set true after explicit user approval"),
    },
    async execute(args, ctx) {
      ctx.metadata({ title: `worktree: finish ${args.branch || "current"}` })

      const repoRoot = getMainWorktreeRoot(projectDir)
      const current = getCurrentLinkedWorktree(repoRoot, ctx.directory)
      const targetBranch = args.branch || current?.branch

      if (!targetBranch) return "No linked worktree to finish. Pass branch to finish a worktree."

      const entry = findGitWorktreeByBranch(repoRoot, targetBranch)
      if (!entry) return `Worktree '${targetBranch}' not found or is main worktree.`

      const isCurrentWorktree = current?.path === entry.path
      if (isCurrentWorktree && !(await canSwitchFromSession(baseUrl, inProcessFetch, projectDir, ctx.sessionID))) {
        return ROOT_SWITCH_REQUIRED_MESSAGE
      }

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
        git(`worktree remove ${shellQuote(entry.path)}${forceFlag}`, repoRoot)
      }

      const lines = [`Worktree '${targetBranch}' removed. Branch still exists for merge/PR.`]

      if (isCurrentWorktree) {
        scheduleWorktreeSessionSwitch({
          branch: getCurrentBranch(repoRoot),
          path: repoRoot,
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          toolName: "worktree_finish",
          projectRoot: repoRoot,
          baseUrl,
          fetch: inProcessFetch,
          prompt: FINISH_CONTINUATION_PROMPT,
        })
        lines.push("", `Session switched back to main project. Stop here; continuation resumes in the main session.`)
      }

      return lines.join("\n")
    },
  })
}

// --- Plugin export ---

const WorktreeManagerPlugin = async (input: PluginInput) => {
  const { client, directory: projectDir } = input

  // Extract in-process fetch from V1 client (opencode injects Server.Default().app.fetch)
  const v1Internal = (client as any)._client ?? (client as any).client
  const v1Config = v1Internal?.getConfig?.() ?? {}
  const inProcessFetch = v1Config.fetch ?? globalThis.fetch
  const baseUrl = v1Config.baseUrl ?? "http://localhost:4096"

  return {
    "experimental.chat.system.transform": async (_input: any, output: { system: string[] }) => {
      output.system.push(WORKTREE_TOOL_INSTRUCTIONS)
    },

    tool: {
      worktree_create: createWorktreeCreateTool(projectDir, inProcessFetch, baseUrl),
      worktree_list: createWorktreeListTool(projectDir),
      worktree_switch: createWorktreeSwitchTool(projectDir, inProcessFetch, baseUrl),
      worktree_status: createWorktreeStatusTool(projectDir),
      worktree_finish: createWorktreeFinishTool(projectDir, inProcessFetch, baseUrl),
    },
  }
}

export { WorktreeManagerPlugin }
export default WorktreeManagerPlugin
