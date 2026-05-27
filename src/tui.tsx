import { createSignal, createMemo, For, Show, onMount, onCleanup } from "solid-js"
import type { TuiPluginApi, TuiPluginModule, TuiPlugin } from "@opencode-ai/plugin/tui"

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

const STATUS_REL_PATH = "worktree/status.json"
const POLL_INTERVAL_MS = 5000

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
    return JSON.parse(content)
  } catch {
    return { worktrees: [] }
  }
}

function View(props: { api: TuiPluginApi }) {
  const [state, setState] = createSignal<WorktreeState>({ worktrees: [] })
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current

  const worktrees = createMemo(() => state().worktrees)
  const active = createMemo(() => state().active)

  const statusColor = (entry: WorktreeEntry) => {
    if (entry.branch === active()) return theme().success
    if (entry.status === "active") return theme().info
    return theme().textMuted
  }

  const statusLabel = (entry: WorktreeEntry) => {
    if (entry.branch === active()) return "active"
    return entry.status
  }

  const refresh = async () => {
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
        <text fg={theme().textMuted}>No worktrees active</text>
      </Show>

      <Show when={worktrees().length > 0 && (worktrees().length <= 2 || open())}>
        <For each={worktrees()}>
          {(item) => (
            <box flexDirection="row" gap={1}>
              <text style={{ fg: statusColor(item) }} flexShrink={0}>
                {item.branch === active() ? "→" : "•"}
              </text>
              <text fg={theme().text} wrapMode="word">
                {item.branch}
                {item.story ? ` (${item.story})` : ""}
                {" "}
                <span style={{ fg: theme().textMuted }}>
                  {statusLabel(item)}
                </span>
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
      sidebar_content() {
        return <View api={api} />
      },
    },
  })
}

const plugin: TuiPluginModule = {
  id: "worktree-manager.sidebar",
  tui,
}

export default plugin
