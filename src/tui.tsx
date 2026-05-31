import { createSignal, createMemo, For, Show, onMount, onCleanup } from "solid-js"
import type { TuiPluginApi, TuiPluginModule, TuiPlugin } from "@opencode-ai/plugin/tui"

interface WorktreeEntry {
  branch: string
  path: string
}

interface WorkspaceInfo {
  type?: string
  name?: string | null
  branch?: string | null
  directory?: string | null
}

interface SdkWorktreeObject {
  name?: string | null
  branch?: string | null
  directory?: string | null
}

type SdkWorktreeInfo = string | SdkWorktreeObject

const WORKSPACE_TYPE = "worktree"
const POLL_INTERVAL_MS = 5000
const ROUTE_POLL_INTERVAL_MS = 100
const SESSION_SELECT_REFRESH_MS = 100
const STARTUP_REFRESH_DELAYS_MS = [50, 150, 300, 600, 1000]

async function readWorktrees(api: TuiPluginApi): Promise<WorktreeEntry[]> {
  try {
    const projectDirectory = api.state.path?.directory
    if (!projectDirectory) return []

    const directory = getMainProjectRoot(projectDirectory)

    const gitWorktrees = await readGitWorktrees(api, directory)
    if (gitWorktrees.length > 0) return gitWorktrees

    const workspaceClient = (api.client as any).experimental?.workspace
    if (!workspaceClient) return []

    await workspaceClient.syncList({ directory })
    const result = await workspaceClient.list({ directory })
    if (result?.error) return []

    return ((result?.data ?? []) as WorkspaceInfo[]).filter(isWorktreeWorkspace).map(toWorktreeEntry)
  } catch {
    return []
  }
}

async function readGitWorktrees(api: TuiPluginApi, directory: string): Promise<WorktreeEntry[]> {
  const worktreeClient = (api.client as any).worktree
  if (!worktreeClient) return []

  const result = await worktreeClient.list({ directory })
  if (result?.error) return []

  return ((result?.data ?? []) as SdkWorktreeInfo[]).flatMap(toSdkWorktreeEntry)
}

function toSdkWorktreeEntry(worktree: SdkWorktreeInfo): WorktreeEntry[] {
  if (typeof worktree === "string") return worktree ? [{ branch: getPathName(worktree), path: worktree }] : []
  if (!worktree.directory) return []
  return [{
    branch: worktree.branch ?? worktree.name ?? getPathName(worktree.directory),
    path: worktree.directory,
  }]
}

function isWorktreeWorkspace(workspace: WorkspaceInfo): workspace is WorkspaceInfo & { directory: string } {
  return workspace.type === WORKSPACE_TYPE && typeof workspace.directory === "string" && workspace.directory.length > 0
}

function toWorktreeEntry(workspace: WorkspaceInfo & { directory: string }): WorktreeEntry {
  return {
    branch: workspace.branch ?? workspace.name ?? getPathName(workspace.directory),
    path: workspace.directory,
  }
}

function getMainProjectRoot(projectRoot: string): string {
  const parts = projectRoot.split("/").filter(Boolean)
  const worktreeContainerIndex = getWorktreeContainerIndex(parts)
  if (worktreeContainerIndex === -1) return projectRoot

  const container = parts[worktreeContainerIndex]
  return `/${[...parts.slice(0, worktreeContainerIndex), container.slice(0, -"-worktrees".length)].join("/")}`
}

function getWorktreeContainerIndex(parts: string[]): number {
  for (let index = parts.length - 1; index >= 0; index--) {
    if (parts[index].endsWith("-worktrees")) return index
  }
  return -1
}

function getSessionDirectory(api: TuiPluginApi, sessionID?: string): string | undefined {
  if (!sessionID) return api.state.path?.worktree ?? api.state.path?.directory
  const session = api.state.session.get(sessionID) as any
  if (session?.workspaceID) return api.state.path?.worktree ?? session?.directory ?? session?.path
  return session?.directory ?? session?.path ?? api.state.path?.worktree ?? api.state.path?.directory
}

function getRouteSessionID(api: TuiPluginApi): string | undefined {
  const route = api.route.current
  return route.name === "session" ? route.params.sessionID : undefined
}

function isPathInside(path: string | undefined, directory: string): boolean {
  if (!path) return false
  return path === directory || path.startsWith(`${directory}/`)
}

function getCurrentWorktree(worktrees: WorktreeEntry[], directory: string | undefined, branch: string | undefined) {
  const directoryMatch = worktrees.find((entry) => isPathInside(directory, entry.path))
  if (directory || !branch) return directoryMatch
  return worktrees.find((entry) => entry.branch === branch)
}

function getDisplayPath(path: string) {
  const home = process.env.HOME
  return home ? path.replace(home, "~") : path
}

function getPathName(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? path
}

function getProjectName(path: string, isWorktree: boolean) {
  if (isWorktree) return getPathName(getMainProjectRoot(path))
  return getPathName(path)
}

function useWorktreeViewState(api: TuiPluginApi, initialSessionID?: string) {
  const [worktrees, setWorktrees] = createSignal<WorktreeEntry[]>([])
  const [selectedSessionID, setSelectedSessionID] = createSignal(getRouteSessionID(api) ?? initialSessionID)
  const [currentDirectory, setCurrentDirectory] = createSignal(getSessionDirectory(api, selectedSessionID()))
  const [currentBranch, setCurrentBranch] = createSignal(api.state.vcs?.branch)

  const refresh = async (sessionID = selectedSessionID()) => {
    const routeSessionID = getRouteSessionID(api)
    if (routeSessionID && routeSessionID !== sessionID) {
      setSelectedSessionID(routeSessionID)
      sessionID = routeSessionID
    }
    setCurrentDirectory(getSessionDirectory(api, sessionID))
    setWorktrees(await readWorktrees(api))
  }

  const handleSessionSelect = (sessionID: string) => {
    if (sessionID === selectedSessionID()) return
    setSelectedSessionID(sessionID)
    void refresh(sessionID)
    setTimeout(() => void refresh(sessionID), SESSION_SELECT_REFRESH_MS)
  }

  const handleRouteChange = () => {
    const sessionID = getRouteSessionID(api)
    if (sessionID) handleSessionSelect(sessionID)
  }

  const handleSessionHydrate = (sessionID: string) => {
    const routeSessionID = getRouteSessionID(api) ?? selectedSessionID()
    if (sessionID !== routeSessionID) return
    setSelectedSessionID(sessionID)
    void refresh(sessionID)
    setTimeout(() => void refresh(sessionID), SESSION_SELECT_REFRESH_MS)
  }

  const handleBranchUpdate = (branch: string | undefined) => {
    setCurrentBranch(branch)
    void refresh(selectedSessionID())
  }

  return {
    worktrees,
    currentDirectory,
    currentBranch,
    refresh,
    handleSessionSelect,
    handleRouteChange,
    handleSessionHydrate,
    handleBranchUpdate,
  }
}

function useWorktreeRefresh(props: {
  api: TuiPluginApi
  refresh: () => Promise<void>
  handleSessionSelect: (sessionID: string) => void
  handleRouteChange: () => void
  handleSessionHydrate: (sessionID: string) => void
  handleBranchUpdate: (branch: string | undefined) => void
}) {
  onMount(() => {
    props.refresh()
    for (const delay of STARTUP_REFRESH_DELAYS_MS) {
      const timeout = setTimeout(() => void props.refresh(), delay)
      onCleanup(() => clearTimeout(timeout))
    }
    const interval = setInterval(() => void props.refresh(), POLL_INTERVAL_MS)
    onCleanup(() => clearInterval(interval))
  })

  onMount(() => {
    const interval = setInterval(props.handleRouteChange, ROUTE_POLL_INTERVAL_MS)
    onCleanup(() => clearInterval(interval))
  })

  onMount(() => {
    const off = props.api.event.on("tool.execute.after", (evt: any) => {
      const toolName = evt?.properties?.tool
      if (toolName?.startsWith("worktree_")) {
        setTimeout(() => void props.refresh(), 300)
      }
    })
    onCleanup(off)
  })

  onMount(() => {
    const off = props.api.event.on("tui.session.select", (evt) => props.handleSessionSelect(evt.properties.sessionID))
    onCleanup(off)
  })

  onMount(() => {
    const off = props.api.event.on("session.created", (evt) => props.handleSessionHydrate(evt.properties.sessionID))
    onCleanup(off)
  })

  onMount(() => {
    const off = props.api.event.on("session.updated", (evt) => props.handleSessionHydrate(evt.properties.sessionID))
    onCleanup(off)
  })

  onMount(() => {
    const off = props.api.event.on("vcs.branch.updated", (evt) => props.handleBranchUpdate(evt.properties.branch))
    onCleanup(off)
  })
}

function WorktreeList(props: { api: TuiPluginApi; sessionID?: string }) {
  const viewState = useWorktreeViewState(props.api, props.sessionID)
  const [open, setOpen] = createSignal(false)
  const theme = () => props.api.theme.current

  const worktrees = createMemo(() => viewState.worktrees())
  const current = createMemo(() => getCurrentWorktree(worktrees(), viewState.currentDirectory(), viewState.currentBranch()))
  const canToggle = createMemo(() => worktrees().length > 0)
  const visibleWorktrees = createMemo(() => (open() ? worktrees() : current() ? [current()!] : []))
  const isCurrent = (entry: WorktreeEntry) => {
    return current()?.path === entry.path
  }

  useWorktreeRefresh({
    api: props.api,
    refresh: viewState.refresh,
    handleSessionSelect: viewState.handleSessionSelect,
    handleRouteChange: viewState.handleRouteChange,
    handleSessionHydrate: viewState.handleSessionHydrate,
    handleBranchUpdate: viewState.handleBranchUpdate,
  })

  return (
    <box>
        <box
          flexDirection="row"
          gap={1}
          onMouseDown={() => canToggle() && setOpen((x) => !x)}
        >
        <Show when={canToggle()}>
          <text fg={theme().text}>{open() ? "[-]" : "[+]"}</text>
        </Show>
        <text fg={theme().text}>
          <b>Worktrees</b>
          <Show when={!open() && worktrees().length > 0}>
            <span style={{ fg: theme().textMuted }}>
              {" "}({worktrees().length} total)
            </span>
          </Show>
        </text>
      </box>

      <Show when={worktrees().length === 0}>
        <text fg={theme().textMuted}>No worktrees</text>
      </Show>

      <Show when={visibleWorktrees().length > 0}>
        <For each={visibleWorktrees()}>
          {(item) => (
            <box flexDirection="row" gap={1}>
              <text style={{ fg: isCurrent(item) ? theme().success : theme().textMuted }} flexShrink={0}>
                ●
              </text>
              <text fg={isCurrent(item) ? theme().text : theme().textMuted} wrapMode="word">
                {item.branch}
                <Show when={isCurrent(item)}>
                  <span style={{ fg: theme().textMuted }}>{" current"}</span>
                </Show>
              </text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}

function WorktreeFooter(props: { api: TuiPluginApi; sessionID?: string }) {
  const viewState = useWorktreeViewState(props.api, props.sessionID)
  const theme = () => props.api.theme.current
  const current = createMemo(() => getCurrentWorktree(viewState.worktrees(), viewState.currentDirectory(), viewState.currentBranch()))
  const footer = createMemo(() => {
    const entry = current()
    const path = entry?.path ?? viewState.currentDirectory() ?? props.api.state.path.directory
    return {
      path: getDisplayPath(path),
      branch: entry?.branch ?? props.api.state.vcs?.branch ?? "unknown",
      project: getProjectName(path, Boolean(entry)),
      worktree: entry?.branch ?? "main",
    }
  })

  useWorktreeRefresh({
    api: props.api,
    refresh: viewState.refresh,
    handleSessionSelect: viewState.handleSessionSelect,
    handleRouteChange: viewState.handleRouteChange,
    handleSessionHydrate: viewState.handleSessionHydrate,
    handleBranchUpdate: viewState.handleBranchUpdate,
  })

  return (
    <box gap={1}>
      <box borderStyle="rounded" borderColor={theme().border} paddingLeft={1} paddingRight={1} gap={0}>
        <text>
          <span style={{ fg: theme().textMuted }}>Project: </span>
          <span style={{ fg: theme().text }}>{footer().project}</span>
        </text>
        <text>
          <span style={{ fg: theme().textMuted }}>Branch: </span>
          <span style={{ fg: theme().text }}>{footer().branch}</span>
        </text>
        <Show when={current()}>
          <text>
            <span style={{ fg: theme().textMuted }}>Worktree: </span>
            <span style={{ fg: theme().success }}>● </span>
            <span style={{ fg: theme().text }}>{footer().worktree}</span>
          </text>
        </Show>
        <text fg={theme().textMuted}>{footer().path}</text>
      </box>
      <text fg={theme().textMuted}>
        <span style={{ fg: theme().success }}>•</span> <b>Open</b>
        <span style={{ fg: theme().text }}>
          <b>Code</b>
        </span>{" "}
        <span>{props.api.app.version}</span>
      </text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 200,
    slots: {
      sidebar_content(props) {
        return <WorktreeList api={api} sessionID={props.session_id} />
      },
    },
  })

  api.slots.register({
    order: 99,
    slots: {
      sidebar_footer(props) {
        return <WorktreeFooter api={api} sessionID={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule = {
  id: "worktree-manager.sidebar",
  tui,
}

export default plugin
