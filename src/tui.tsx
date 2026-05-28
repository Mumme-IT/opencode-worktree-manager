import { createSignal, createMemo, For, Show, onMount, onCleanup } from "solid-js"
import type { TuiPluginApi, TuiPluginModule, TuiPlugin } from "@opencode-ai/plugin/tui"

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

const STATUS_REL_PATH = "worktree/status.json"
const POLL_INTERVAL_MS = 5000
const SESSION_SELECT_REFRESH_MS = 100

async function readState(api: TuiPluginApi): Promise<WorktreeState> {
  try {
    const stateDir = api.state.path?.state
    if (!stateDir) return { worktrees: [] }

    const result = await api.client.file.read({
      path: STATUS_REL_PATH,
      directory: stateDir,
    })
    const content = (result as any)?.data?.content
    if (!content || typeof content !== "string") return { worktrees: [] }
    const parsed = JSON.parse(content)
    return { worktrees: parsed.worktrees ?? [] }
  } catch {
    return { worktrees: [] }
  }
}

function getSessionDirectory(api: TuiPluginApi, sessionID?: string): string | undefined {
  if (!sessionID) return api.state.path?.worktree ?? api.state.path?.directory
  const session = api.state.session.get(sessionID) as any
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

function View(props: { api: TuiPluginApi; sessionID?: string }) {
  const [state, setState] = createSignal<WorktreeState>({ worktrees: [] })
  const [selectedSessionID, setSelectedSessionID] = createSignal(getRouteSessionID(props.api) ?? props.sessionID)
  const [currentDirectory, setCurrentDirectory] = createSignal(getSessionDirectory(props.api, selectedSessionID()))
  const [currentBranch, setCurrentBranch] = createSignal(props.api.state.vcs?.branch)
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current

  const worktrees = createMemo(() => state().worktrees)
  const isCurrent = (entry: WorktreeEntry) => {
    return isPathInside(currentDirectory(), entry.path) || entry.branch === currentBranch()
  }

  const statusColor = (entry: WorktreeEntry) => {
    return isCurrent(entry) ? theme().success : theme().textMuted
  }

  const refresh = async (sessionID = selectedSessionID()) => {
    setCurrentDirectory(getSessionDirectory(props.api, sessionID))
    const result = await readState(props.api)
    setState(result)
  }

  // Poll for updates
  onMount(() => {
    refresh()
    const interval = setInterval(() => void refresh(), POLL_INTERVAL_MS)
    onCleanup(() => clearInterval(interval))
  })

  // Refresh on worktree tool calls
  onMount(() => {
    const off = props.api.event.on("tool.execute.after", (evt: any) => {
      const toolName = evt?.properties?.tool
      if (toolName?.startsWith("worktree_")) {
        setTimeout(() => void refresh(), 300)
      }
    })
    onCleanup(off)
  })

  onMount(() => {
    const off = props.api.event.on("tui.session.select", (evt) => {
      const sessionID = evt.properties.sessionID
      setSelectedSessionID(sessionID)
      void refresh(sessionID)
      setTimeout(() => void refresh(sessionID), SESSION_SELECT_REFRESH_MS)
    })
    onCleanup(off)
  })

  onMount(() => {
    const off = props.api.event.on("vcs.branch.updated", (evt) => {
      setCurrentBranch(evt.properties.branch)
      void refresh(selectedSessionID())
    })
    onCleanup(off)
  })

  return (
    <box>
      <box
        flexDirection="row"
        gap={1}
        onMouseDown={() => worktrees().length > 2 && setOpen((x) => !x)}
      >
        <Show when={worktrees().length > 2}>
          <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
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

      <Show when={worktrees().length > 0 && (worktrees().length <= 2 || open())}>
        <For each={worktrees()}>
          {(item) => (
            <box flexDirection="row" gap={1}>
              <text style={{ fg: statusColor(item) }} flexShrink={0}>
                {isCurrent(item) ? "→" : "•"}
              </text>
              <text fg={theme().text} wrapMode="word">
                {item.branch}
                {item.story ? ` (${item.story})` : ""}
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

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 200,
    slots: {
      sidebar_content(props) {
        return <View api={api} sessionID={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule = {
  id: "worktree-manager.sidebar",
  tui,
}

export default plugin
