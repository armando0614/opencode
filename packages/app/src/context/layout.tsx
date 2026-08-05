import { createStore, produce, reconcile } from "solid-js/store"
import { batch, createEffect, createMemo, onCleanup, onMount, type Accessor } from "solid-js"
import { useLocation } from "@solidjs/router"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { makeEventListener } from "@solid-primitives/event-listener"
import { useServerSync } from "./server-sync"
import { useServerSDK } from "./server-sdk"
import { ServerConnection, useServer } from "./server"
import { usePlatform } from "./platform"
import { Project } from "@opencode-ai/sdk/v2"
import { Persist, persisted, removePersisted } from "@/utils/persist"
import { decode64 } from "@/utils/base64"
import { same } from "@/utils/same"
import { createScrollPersistence, type SessionScroll } from "./layout-scroll"
import { createPathHelpers } from "./file/path"
import type { ProjectAvatarVariant } from "@opencode-ai/ui/v2/project-avatar-v2"
import { migrateLegacySessionStateKeys, ServerScope, SessionStateKey } from "@/utils/server-scope"
import { createSessionKeyReader, ensureSessionKey, pruneSessionKeys } from "./layout-helpers"
import { requireServerKey } from "@/utils/session-route"
import { type DraftTab, useTabs } from "./tabs"

export { createSessionKeyReader, ensureSessionKey, pruneSessionKeys }

export type { ProjectAvatarVariant }

const AVATAR_COLOR_KEYS = ["pink", "mint", "orange", "purple", "cyan", "lime"] as const
const DEFAULT_SIDEBAR_WIDTH = 344
const DEFAULT_FILE_TREE_WIDTH = 200
const DEFAULT_SESSION_WIDTH = 600
const DEFAULT_TERMINAL_HEIGHT = 280
const DEFAULT_REVIEW_PANEL_OPENED = false
const DEFAULT_BROWSER_PREVIEW_WIDTH = 480
const DEFAULT_BROWSER_PREVIEW_URL = "http://localhost:3000"
export type AvatarColorKey = (typeof AVATAR_COLOR_KEYS)[number]

export function getAvatarColors(key?: string) {
  if (key && AVATAR_COLOR_KEYS.includes(key as AvatarColorKey)) {
    return {
      background: `var(--avatar-background-${key})`,
      foreground: `var(--avatar-text-${key})`,
    }
  }
  return {
    background: "var(--surface-info-base)",
    foreground: "var(--text-base)",
  }
}

export function getProjectAvatarVariant(key?: string): ProjectAvatarVariant {
  if (key === "orange") return "orange"
  if (key === "pink") return "pink"
  if (key === "cyan") return "cyan"
  if (key === "purple") return "purple"
  if (key === "mint") return "cyan"
  if (key === "lime") return "green"
  return "gray"
}

type SessionTabs = {
  active?: string
  all: string[]
}

type SessionPanels = {
  terminal: { opened: boolean; height: number }
  review: { panelOpened: boolean }
  fileTree: { opened: boolean; width: number; tab: "changes" | "all" }
  session: { width: number }
  browserPreview: { opened: boolean; width: number; url: string }
}

const defaultSessionPanels = (): SessionPanels => ({
  terminal: { opened: false, height: DEFAULT_TERMINAL_HEIGHT },
  review: { panelOpened: DEFAULT_REVIEW_PANEL_OPENED },
  fileTree: { opened: false, width: DEFAULT_FILE_TREE_WIDTH, tab: "changes" },
  session: { width: DEFAULT_SESSION_WIDTH },
  browserPreview: {
    opened: false,
    width: DEFAULT_BROWSER_PREVIEW_WIDTH,
    url: DEFAULT_BROWSER_PREVIEW_URL,
  },
})

type SessionView = {
  scroll: Record<string, SessionScroll>
  reviewOpen?: string[]
  pendingMessage?: string
  pendingMessageAt?: number
  todoCollapsed?: boolean
  panels?: SessionPanels
}

type TabHandoff = {
  scope: ServerScope
  dir: string
  id: string
  at: number
}

export type LocalProject = Partial<Project> & { worktree: string; expanded: boolean }
export type HomeProjectSelection = { server: ServerConnection.Key; directory?: string }

export type ReviewDiffStyle = "unified" | "split"
export type ReviewPanelSource = "context-button" | "other"

export type LayoutRoute =
  | { type: "home" }
  | { type: "draft"; draftID: string; server?: ServerConnection.Key }
  | { type: "dir-new-sesssion"; dir: string; dirBase64: string; server?: ServerConnection.Key }
  | { type: "session"; sessionId: string; server?: ServerConnection.Key }

function nextSessionTabsForOpen(current: SessionTabs | undefined, tab: string): SessionTabs {
  const all = current?.all ?? []
  if (tab === "review") return { all: all.filter((x) => x !== "review"), active: tab }
  if (tab === "context") return { all: [tab, ...all.filter((x) => x !== tab)], active: tab }
  if (!all.includes(tab)) return { all: [...all, tab], active: tab }
  return { all, active: tab }
}

const sessionPath = (key: string) => {
  const dir = SessionStateKey.route(key).split("/")[0]
  if (!dir) return
  const root = decode64(dir)
  if (!root) return
  return createPathHelpers(() => root)
}

const normalizeSessionTab = (path: ReturnType<typeof createPathHelpers> | undefined, tab: string) => {
  if (!tab.startsWith("file://")) return tab
  if (!path) return tab
  return path.tab(tab)
}

const normalizeSessionTabList = (path: ReturnType<typeof createPathHelpers> | undefined, all: string[]) => {
  const seen = new Set<string>()
  return all.flatMap((tab) => {
    const value = normalizeSessionTab(path, tab)
    if (seen.has(value)) return []
    seen.add(value)
    return [value]
  })
}

const normalizeStoredSessionTabs = (key: string, tabs: SessionTabs) => {
  const path = sessionPath(key)
  return {
    all: normalizeSessionTabList(path, tabs.all),
    active: tabs.active ? normalizeSessionTab(path, tabs.active) : tabs.active,
  }
}

const currentRoute = (pathname: string, search: string): LayoutRoute => {
  const parts = pathname.split("/").filter(Boolean)
  if (parts.length === 0) return { type: "home" }

  if (parts[0] === "new-session") {
    const draftID = new URLSearchParams(search).get("draftId")
    if (!draftID) return { type: "home" }
    return { type: "draft", draftID }
  }

  if (parts[0] === "server" && parts[2] === "session" && parts[3]) {
    return {
      type: "session",
      sessionId: parts[3],
      server: requireServerKey(parts[1]),
    }
  }

  const dirBase64 = parts[0]
  const dir = decode64(dirBase64)
  if (!dir) return { type: "home" }

  if (parts[1] !== "session") return { type: "home" }

  const id = parts[2]
  if (id) return { type: "session", sessionId: id }
  return { type: "dir-new-sesssion", dir, dirBase64 }
}

export const { use: useLayout, provider: LayoutProvider } = createSimpleContext({
  name: "Layout",
  gate: false,
  init: () => {
    const serverSdk = useServerSDK()
    const serverSync = useServerSync()
    const server = useServer()
    const tabs = useTabs()
    const platform = usePlatform()
    const location = useLocation()
    const route = createMemo(() => {
      const value = currentRoute(location.pathname, location.search)
      if (value.type === "home") return value
      if (value.server) return value
      if (value.type === "draft") {
        const draft = tabs.store.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === value.draftID)
        if (draft) return { ...value, server: draft.server }
      }
      return { ...value, server: server.key }
    })

    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value)

    const migrate = (value: unknown) => {
      if (!isRecord(value)) return value

      const sidebar = value.sidebar
      const migratedSidebar = (() => {
        if (!isRecord(sidebar)) return sidebar
        if (typeof sidebar.workspaces !== "boolean") return sidebar
        return {
          ...sidebar,
          workspaces: {},
          workspacesDefault: sidebar.workspaces,
        }
      })()

      const review = value.review
      const fileTree = value.fileTree
      const migratedFileTree = (() => {
        if (!isRecord(fileTree)) return fileTree
        if (fileTree.tab === "changes" || fileTree.tab === "all") return fileTree

        const width = typeof fileTree.width === "number" ? fileTree.width : DEFAULT_FILE_TREE_WIDTH
        return {
          ...fileTree,
          opened: true,
          width: width === 260 ? DEFAULT_FILE_TREE_WIDTH : width,
          tab: "changes",
        }
      })()

      const migratedReview = (() => {
        if (!isRecord(review)) return review
        if (typeof review.panelOpened === "boolean") return review

        const opened =
          isRecord(fileTree) && typeof fileTree.opened === "boolean" ? fileTree.opened : DEFAULT_REVIEW_PANEL_OPENED
        return {
          ...review,
          panelOpened: opened,
        }
      })()

      const sessionTabs = migrateLegacySessionStateKeys(value.sessionTabs)
      const sessionView = migrateLegacySessionStateKeys(value.sessionView)
      const migratedSessionTabs = (() => {
        if (!isRecord(sessionTabs)) return sessionTabs

        let changed = false
        const next = Object.fromEntries(
          Object.entries(sessionTabs).map(([key, tabs]) => {
            if (!isRecord(tabs) || !Array.isArray(tabs.all)) return [key, tabs]

            const current = {
              all: tabs.all.filter((tab): tab is string => typeof tab === "string"),
              active: typeof tabs.active === "string" ? tabs.active : undefined,
            }
            const normalized = normalizeStoredSessionTabs(key, current)
            if (current.all.length !== tabs.all.length) changed = true
            if (!same(current.all, normalized.all) || current.active !== normalized.active) changed = true
            if (tabs.active !== undefined && typeof tabs.active !== "string") changed = true
            return [key, normalized]
          }),
        )

        if (!changed) return sessionTabs
        return next
      })()

      // v6 → v7: seed per-session panels from the universal panel state, then drop
      // the universal panel fields. Sessions not present in sessionView start with defaults.
      const migratedPanels = ((): { sessionView: unknown; value: unknown } => {
        if (!isRecord(sessionView)) return { sessionView, value: value.sessionView }
        const hasUniversal = [
          value.terminal,
          value.review,
          value.fileTree,
          value.session,
          value.browserPreview,
        ].some(isRecord)
        if (!hasUniversal) return { sessionView, value: value.sessionView }

        const seeded: SessionPanels = (() => {
          const t = isRecord(value.terminal) ? value.terminal : undefined
          const r = isRecord(value.review) ? value.review : undefined
          const f = isRecord(value.fileTree) ? value.fileTree : undefined
          const s = isRecord(value.session) ? value.session : undefined
          const b = isRecord(value.browserPreview) ? value.browserPreview : undefined
          return {
            terminal: {
              opened: typeof t?.opened === "boolean" ? t.opened : false,
              height: typeof t?.height === "number" ? t.height : DEFAULT_TERMINAL_HEIGHT,
            },
            review: {
              panelOpened:
                typeof r?.panelOpened === "boolean" ? r.panelOpened : DEFAULT_REVIEW_PANEL_OPENED,
            },
            fileTree: {
              opened: typeof f?.opened === "boolean" ? f.opened : false,
              width: typeof f?.width === "number" ? f.width : DEFAULT_FILE_TREE_WIDTH,
              tab: f?.tab === "all" ? "all" : "changes",
            },
            session: {
              width: typeof s?.width === "number" ? s.width : DEFAULT_SESSION_WIDTH,
            },
            browserPreview: {
              opened: typeof b?.opened === "boolean" ? b.opened : false,
              width: typeof b?.width === "number" ? b.width : DEFAULT_BROWSER_PREVIEW_WIDTH,
              url: typeof b?.url === "string" ? b.url : DEFAULT_BROWSER_PREVIEW_URL,
            },
          }
        })()

        let changed = false
        const next = Object.fromEntries(
          Object.entries(sessionView).map(([key, view]) => {
            if (!isRecord(view)) return [key, view]
            if (view.panels) return [key, view]
            changed = true
            return [key, { ...view, panels: seeded }]
          }),
        )
        if (!changed) return { sessionView, value: value.sessionView }
        return { sessionView: next, value: next }
      })()

      const finalSessionView = migratedPanels.sessionView

      if (
        migratedSidebar === sidebar &&
        migratedReview === review &&
        migratedFileTree === fileTree &&
        migratedSessionTabs === value.sessionTabs &&
        finalSessionView === sessionView
      ) {
        return value
      }

      const next: Record<string, unknown> = {
        ...value,
        sidebar: migratedSidebar,
        review: migratedReview,
        fileTree: migratedFileTree,
        sessionTabs: migratedSessionTabs,
        sessionView: finalSessionView,
      }

      // Drop the v6 universal panel fields; review.diffStyle and mobileSidebar stay.
      delete next.terminal
      delete next.session
      delete next.browserPreview
      if (isRecord(next.review)) {
        const { panelOpened: _panel, ...rest } = next.review
        next.review = rest
      }

      return next
    }

    const target = Persist.serverGlobal(serverSdk().scope, "layout", ["layout.v6", "layout.v7"])
    const [store, setStore, _, ready] = persisted(
      { ...target, migrate },
      createStore({
        sidebar: {
          opened: false,
          width: DEFAULT_SIDEBAR_WIDTH,
          workspaces: {} as Record<string, boolean>,
          workspacesDefault: false,
        },
        review: {
          diffStyle: "split" as ReviewDiffStyle,
        },
        mobileSidebar: {
          opened: false,
        },
        sessionTabs: {} as Record<string, SessionTabs>,
        sessionView: {} as Record<string, SessionView>,
        handoff: {
          tabs: undefined as TabHandoff | undefined,
        },
        home: {
          selection: { server: server.key } as HomeProjectSelection,
        },
      }),
    )
    const [ephemeral, setEphemeral] = createStore({
      reviewPanelSource: "other" as ReviewPanelSource,
    })

    const MAX_SESSION_KEYS = 50
    const PENDING_MESSAGE_TTL_MS = 2 * 60 * 1000
    const usage = {
      active: undefined as string | undefined,
      pruned: false,
      used: new Map<string, number>(),
    }

    const SESSION_STATE_KEYS = [
      { key: "prompt", legacy: "prompt", version: "v2" },
      { key: "terminal", legacy: "terminal", version: "v1" },
      { key: "file-view", legacy: "file", version: "v1" },
    ] as const

    const dropSessionState = (keys: string[]) => {
      for (const key of keys) {
        const scope = SessionStateKey.scope(key)
        const parts = SessionStateKey.route(key).split("/")
        const dir = parts[0]
        const session = parts[1]
        if (!dir) continue

        for (const entry of SESSION_STATE_KEYS) {
          const target = session
            ? Persist.serverSession(scope, dir, session, entry.key)
            : Persist.serverWorkspace(scope, dir, entry.key)
          void removePersisted(target, platform)

          if (scope !== ServerScope.local) continue
          const legacyKey = `${dir}/${entry.legacy}${session ? "/" + session : ""}.${entry.version}`
          void removePersisted({ key: legacyKey }, platform)
        }
      }
    }

    function prune(keep?: string) {
      const drop = pruneSessionKeys({
        keep,
        max: MAX_SESSION_KEYS,
        used: usage.used,
        view: Object.keys(store.sessionView),
        tabs: Object.keys(store.sessionTabs),
      })
      if (drop.length === 0) return

      setStore(
        produce((draft) => {
          for (const key of drop) {
            delete draft.sessionView[key]
            delete draft.sessionTabs[key]
          }
        }),
      )

      scroll.drop(drop)
      dropSessionState(drop)

      for (const key of drop) {
        usage.used.delete(key)
      }
    }

    function touch(sessionKey: string) {
      usage.active = sessionKey
      usage.used.set(sessionKey, Date.now())

      if (!ready()) return
      if (usage.pruned) return

      usage.pruned = true
      prune(sessionKey)
    }

    const scroll = createScrollPersistence({
      debounceMs: 250,
      getSnapshot: (sessionKey) => store.sessionView[sessionKey]?.scroll,
      onFlush: (sessionKey, next) => {
        const current = store.sessionView[sessionKey]
        const keep = usage.active ?? sessionKey
        if (!current) {
          setStore("sessionView", sessionKey, { scroll: next })
          prune(keep)
          return
        }

        setStore("sessionView", sessionKey, "scroll", (prev) => ({ ...prev, ...next }))
        prune(keep)
      },
    })

    const ensureKey = (key: string) => ensureSessionKey(key, touch, (sessionKey) => scroll.seed(sessionKey))

    createEffect(() => {
      if (!ready()) return
      if (usage.pruned) return
      const active = usage.active
      if (!active) return
      usage.pruned = true
      prune(active)
    })

    onMount(() => {
      const flush = () => batch(() => scroll.flushAll())
      const handleVisibility = () => {
        if (document.visibilityState !== "hidden") return
        flush()
      }

      makeEventListener(window, "pagehide", flush)
      makeEventListener(document, "visibilitychange", handleVisibility)

      onCleanup(() => {
        scroll.dispose()
      })
    })

    const [colors, setColors] = createStore<Record<string, AvatarColorKey>>({})
    const colorRequested = new Map<string, AvatarColorKey>()

    function pickAvailableColor(used: Set<string>): AvatarColorKey {
      const available = AVATAR_COLOR_KEYS.filter((c) => !used.has(c))
      if (available.length === 0) return AVATAR_COLOR_KEYS[Math.floor(Math.random() * AVATAR_COLOR_KEYS.length)]
      return available[Math.floor(Math.random() * available.length)]
    }

    function enrich(project: { worktree: string; expanded: boolean }) {
      const [childStore] = serverSync().child(project.worktree, { bootstrap: false })
      const projectID = childStore.project
      const metadata = projectID
        ? serverSync().data.project.find((x) => x.id === projectID)
        : serverSync().data.project.find((x) => x.worktree === project.worktree)

      // Preserve local icon override from per-workspace localStorage cache (childStore.icon).
      // Without this, different subdirectories of the same git repo would share the same
      // icon from the database instead of using their individual overrides.
      const base = { ...metadata, ...project }
      if (childStore.icon) {
        return { ...base, icon: { ...base.icon, override: childStore.icon } }
      }
      return base
    }

    const roots = createMemo(() => {
      const map = new Map<string, string>()
      for (const project of serverSync().data.project) {
        const sandboxes = project.sandboxes ?? []
        for (const sandbox of sandboxes) {
          map.set(sandbox, project.worktree)
        }
      }
      return map
    })

    const rootFor = (directory: string) => {
      const map = roots()
      if (map.size === 0) return directory

      const visited = new Set<string>()
      const chain = [directory]

      while (chain.length) {
        const current = chain[chain.length - 1]
        if (!current) return directory

        const next = map.get(current)
        if (!next) return current

        if (visited.has(next)) return directory
        visited.add(next)
        chain.push(next)
      }

      return directory
    }

    createEffect(() => {
      const projects = server.projects.list()
      const seen = new Set(projects.map((project) => project.worktree))

      batch(() => {
        for (const project of projects) {
          const root = rootFor(project.worktree)
          if (root === project.worktree) continue

          server.projects.close(project.worktree)

          if (!seen.has(root)) {
            server.projects.open(root)
            seen.add(root)
          }

          if (project.expanded) server.projects.expand(root)
        }
      })
    })

    const enriched = createMemo(() => server.projects.list().map(enrich))
    const list = createMemo(() => {
      const projects = enriched()
      return projects.map((project) => {
        const color = project.icon?.color ?? colors[project.worktree]
        if (!color) return project
        const icon = project.icon ? { ...project.icon, color } : { color }
        return { ...project, icon }
      })
    })

    createEffect(() => {
      const projects = enriched()
      if (projects.length === 0) return
      if (!serverSync().ready) return

      for (const project of projects) {
        if (!project.id) continue
        if (project.id === "global") continue
        serverSync().project.icon(project.worktree, project.icon?.override)
      }
    })

    createEffect(() => {
      const projects = enriched()
      if (projects.length === 0) return

      for (const project of projects) {
        if (project.icon?.color) colorRequested.delete(project.worktree)
      }

      const used = new Set<string>()
      for (const project of projects) {
        const color = project.icon?.color ?? colors[project.worktree]
        if (color) used.add(color)
      }

      for (const project of projects) {
        if (project.icon?.color || project.icon?.override || project.icon?.url) continue
        const worktree = project.worktree
        const existing = colors[worktree]
        const color = existing ?? pickAvailableColor(used)
        if (!existing) {
          used.add(color)
          setColors(worktree, color)
        }
        if (!project.id) continue

        const requested = colorRequested.get(worktree)
        if (requested === color) continue
        colorRequested.set(worktree, color)

        if (project.id === "global") {
          serverSync().project.meta(worktree, { icon: { color } })
          continue
        }

        void serverSdk()
          .client.project.update({ projectID: project.id, directory: worktree, icon: { color } })
          .catch(() => {
            if (colorRequested.get(worktree) === color) colorRequested.delete(worktree)
          })
      }
    })

    let sessionFrame: number | undefined
    let sessionTimer: number | undefined

    onMount(() => {
      sessionFrame = requestAnimationFrame(() => {
        sessionFrame = undefined
        sessionTimer = window.setTimeout(() => {
          sessionTimer = undefined
          void Promise.all(
            server.projects.list().map((project) => {
              return serverSync().project.loadSessions(project.worktree)
            }),
          )
        }, 0)
      })
    })

    onCleanup(() => {
      if (sessionFrame !== undefined) cancelAnimationFrame(sessionFrame)
      if (sessionTimer !== undefined) window.clearTimeout(sessionTimer)
    })

    // --- Flat accessors (Plan A1) -------------------------------------------
    // The store holds per-session panels under `store.sessionView[sessionKey].panels`.
    // Legacy callers (and many existing components) still consume `layout.terminal`,
    // `layout.session`, `layout.fileTree`, `layout.browserPreview` as if those
    // existed at the root of the layout context. These flat accessors delegate to
    // a single "current" session's panels so the rest of the app keeps working
    // unchanged. Writes go through `ensurePanelsForWrite()` which seeds the
    // panels object on demand so consumers never see `undefined`.

    const fallbackKey = (): string => {
      const active = usage.active
      if (active && store.sessionView[active]) return active
      const keys = Object.keys(store.sessionView)
      if (keys.length > 0) return keys[0]!
      return ""
    }

    const flatPanels = (): SessionPanels => {
      const key = fallbackKey()
      const existing = key ? store.sessionView[key]?.panels : undefined
      return existing ?? defaultSessionPanels()
    }

    const ensurePanelsForWrite = (): { sessionKey: string; panels: SessionPanels } => {
      const active = usage.active
      const key = active && store.sessionView[active] ? active : fallbackKey()
      let panels = key ? store.sessionView[key]?.panels : undefined
      if (!panels) panels = defaultSessionPanels()
      if (key && !store.sessionView[key]?.panels) {
        setStore(
          "sessionView",
          key,
          produce((draft: { panels?: SessionPanels }) => {
            draft.panels = panels
          }),
        )
      }
      return { sessionKey: key, panels }
    }

    const flatTerminal = () => {
      const panels = createMemo(() => flatPanels().terminal)
      return {
        height: createMemo(() => panels().height),
        resize(next: number) {
          const { panels: p } = ensurePanelsForWrite()
          if (p.terminal.height === next) return
          setStore("sessionView", ensurePanelsForWrite().sessionKey, "panels", "terminal", "height", next)
        },
      }
    }

    const flatSession = () => {
      const panels = createMemo(() => flatPanels().session)
      return {
        width: createMemo(() => panels().width),
        resize(next: number) {
          const { panels: p } = ensurePanelsForWrite()
          if (p.session.width === next) return
          setStore("sessionView", ensurePanelsForWrite().sessionKey, "panels", "session", "width", next)
        },
      }
    }

    const flatFileTree = () => {
      const panels = createMemo(() => flatPanels().fileTree)
      return {
        opened: createMemo(() => panels().opened),
        width: createMemo(() => panels().width),
        tab: createMemo(() => panels().tab),
        toggle() {
          const { panels: p } = ensurePanelsForWrite()
          setStore(
            "sessionView",
            ensurePanelsForWrite().sessionKey,
            "panels",
            "fileTree",
            "opened",
            !p.fileTree.opened,
          )
        },
        resize(next: number) {
          const { panels: p } = ensurePanelsForWrite()
          if (p.fileTree.width === next) return
          setStore("sessionView", ensurePanelsForWrite().sessionKey, "panels", "fileTree", "width", next)
        },
        setTab(next: "changes" | "all") {
          const { panels: p } = ensurePanelsForWrite()
          if (p.fileTree.tab === next) return
          setStore("sessionView", ensurePanelsForWrite().sessionKey, "panels", "fileTree", "tab", next)
        },
      }
    }

    const flatBrowserPreview = () => {
      const panels = createMemo(() => flatPanels().browserPreview)
      return {
        opened: createMemo(() => panels().opened),
        width: createMemo(() => panels().width),
        url: createMemo(() => panels().url),
        toggle() {
          const { panels: p } = ensurePanelsForWrite()
          const next = !p.browserPreview.opened
          setStore(
            "sessionView",
            ensurePanelsForWrite().sessionKey,
            "panels",
            "browserPreview",
            "opened",
            next,
          )
          if (!next) void platform.browserPreview?.hide()
        },
        close() {
          const { panels: p } = ensurePanelsForWrite()
          if (!p.browserPreview.opened) return
          setStore(
            "sessionView",
            ensurePanelsForWrite().sessionKey,
            "panels",
            "browserPreview",
            "opened",
            false,
          )
          void platform.browserPreview?.hide()
        },
        resize(next: number) {
          const { panels: p } = ensurePanelsForWrite()
          if (p.browserPreview.width === next) return
          setStore("sessionView", ensurePanelsForWrite().sessionKey, "panels", "browserPreview", "width", next)
        },
        setUrl(next: string) {
          const { panels: p } = ensurePanelsForWrite()
          if (p.browserPreview.url === next) return
          setStore("sessionView", ensurePanelsForWrite().sessionKey, "panels", "browserPreview", "url", next)
        },
      }
    }

    // -----------------------------------------------------------------------

    return {
      route,
      ready,
      home: {
        selection: createMemo(() => store.home.selection),
        setSelection(selection: HomeProjectSelection) {
          setStore("home", "selection", reconcile(selection))
        },
      },
      handoff: {
        tabs: createMemo(() => store.handoff?.tabs),
        setTabs(dir: string, id: string) {
          setStore("handoff", "tabs", { scope: serverSdk().scope, dir, id, at: Date.now() })
        },
        clearTabs() {
          if (!store.handoff?.tabs) return
          setStore("handoff", "tabs", undefined)
        },
      },
      projects: {
        list,
        open(directory: string) {
          const root = rootFor(directory)
          if (server.projects.list().find((x) => x.worktree === root)) return
          void serverSync().project.loadSessions(root)
          server.projects.open(root)
        },
        close(directory: string) {
          server.projects.close(directory)
        },
        expand(directory: string) {
          server.projects.expand(directory)
        },
        collapse(directory: string) {
          server.projects.collapse(directory)
        },
        move(directory: string, toIndex: number) {
          server.projects.move(directory, toIndex)
        },
      },
      sidebar: {
        opened: createMemo(() => store.sidebar.opened),
        open() {
          setStore("sidebar", "opened", true)
        },
        close() {
          setStore("sidebar", "opened", false)
        },
        toggle() {
          setStore("sidebar", "opened", (x) => !x)
        },
        width: createMemo(() => store.sidebar.width),
        resize(width: number) {
          setStore("sidebar", "width", width)
        },
        workspaces(directory: string) {
          return () => store.sidebar.workspaces[directory] ?? store.sidebar.workspacesDefault ?? false
        },
        setWorkspaces(directory: string, value: boolean) {
          setStore("sidebar", "workspaces", directory, value)
        },
        toggleWorkspaces(directory: string) {
          const current = store.sidebar.workspaces[directory] ?? store.sidebar.workspacesDefault ?? false
          setStore("sidebar", "workspaces", directory, !current)
        },
      },
      review: {
        diffStyle: createMemo(() => store.review?.diffStyle ?? "split"),
        setDiffStyle(diffStyle: ReviewDiffStyle) {
          if (!store.review) {
            setStore("review", { diffStyle })
            return
          }
          setStore("review", "diffStyle", diffStyle)
        },
      },
      mobileSidebar: {
        opened: createMemo(() => store.mobileSidebar?.opened ?? false),
        show() {
          setStore("mobileSidebar", "opened", true)
        },
        hide() {
          setStore("mobileSidebar", "opened", false)
        },
        toggle() {
          setStore("mobileSidebar", "opened", (x) => !x)
        },
      },
      terminal: flatTerminal(),
      session: flatSession(),
      fileTree: flatFileTree(),
      browserPreview: flatBrowserPreview(),
      pendingMessage: {
        set(sessionKey: string, messageID: string) {
          const at = Date.now()
          touch(sessionKey)
          const current = store.sessionView[sessionKey]
          if (!current) {
            setStore("sessionView", sessionKey, {
              scroll: {},
              pendingMessage: messageID,
              pendingMessageAt: at,
            })
            prune(usage.active ?? sessionKey)
            return
          }

          setStore(
            "sessionView",
            sessionKey,
            produce((draft) => {
              draft.pendingMessage = messageID
              draft.pendingMessageAt = at
            }),
          )
        },
        consume(sessionKey: string) {
          const current = store.sessionView[sessionKey]
          const message = current?.pendingMessage
          const at = current?.pendingMessageAt
          if (!message || !at) return

          setStore(
            "sessionView",
            sessionKey,
            produce((draft) => {
              delete draft.pendingMessage
              delete draft.pendingMessageAt
            }),
          )

          if (Date.now() - at > PENDING_MESSAGE_TTL_MS) return
          return message
        },
      },
      view(sessionKey: string | Accessor<string>) {
        const key = createSessionKeyReader(sessionKey, ensureKey)
        const s = createMemo(() => store.sessionView[key()] ?? { scroll: {} })
        const panels = createMemo(() => s().panels ?? defaultSessionPanels())
        const terminalOpened = createMemo(() => panels().terminal.opened)
        const reviewPanelOpened = createMemo(() => panels().review.panelOpened)
        const reviewPanelSource = createMemo(() => (reviewPanelOpened() ? ephemeral.reviewPanelSource : "other"))

        function getOrInitPanels(): { session: string; current: SessionPanels } {
          const session = key()
          const current = store.sessionView[session]?.panels ?? defaultSessionPanels()
          if (!store.sessionView[session]?.panels) {
            setStore(
              "sessionView",
              session,
              produce((draft) => {
                if (!draft) return
                draft.panels = current
              }),
            )
          }
          return { session, current }
        }

        function setTerminalOpened(next: boolean) {
          const { current } = getOrInitPanels()
          if (current.terminal.opened === next) return
          setStore(
            "sessionView",
            key(),
            "panels",
            "terminal",
            "opened",
            next,
          )
        }

        function setTerminalHeight(next: number) {
          const { current } = getOrInitPanels()
          if (current.terminal.height === next) return
          setStore(
            "sessionView",
            key(),
            "panels",
            "terminal",
            "height",
            next,
          )
        }

        function setReviewPanelOpened(next: boolean, source: ReviewPanelSource) {
          const { current } = getOrInitPanels()
          const nextSource = next ? source : "other"
          if (current.review.panelOpened === next) {
            if (ephemeral.reviewPanelSource !== nextSource) setEphemeral("reviewPanelSource", nextSource)
            return
          }
          batch(() => {
            setStore(
              "sessionView",
              key(),
              "panels",
              "review",
              "panelOpened",
              next,
            )
            setEphemeral("reviewPanelSource", nextSource)
          })
        }

        function setFileTreeOpened(next: boolean) {
          const { current } = getOrInitPanels()
          if (current.fileTree.opened === next) return
          setStore(
            "sessionView",
            key(),
            "panels",
            "fileTree",
            "opened",
            next,
          )
        }

        function setFileTreeTab(next: "changes" | "all") {
          const { current } = getOrInitPanels()
          if (current.fileTree.tab === next) return
          setStore(
            "sessionView",
            key(),
            "panels",
            "fileTree",
            "tab",
            next,
          )
        }

        function setFileTreeWidth(next: number) {
          const { current } = getOrInitPanels()
          if (current.fileTree.width === next) return
          setStore(
            "sessionView",
            key(),
            "panels",
            "fileTree",
            "width",
            next,
          )
        }

        function setSessionWidth(next: number) {
          const { current } = getOrInitPanels()
          if (current.session.width === next) return
          setStore(
            "sessionView",
            key(),
            "panels",
            "session",
            "width",
            next,
          )
        }

        function setBrowserPreviewOpened(next: boolean) {
          const { current } = getOrInitPanels()
          if (current.browserPreview.opened === next) return
          setStore(
            "sessionView",
            key(),
            "panels",
            "browserPreview",
            "opened",
            next,
          )
          if (!next) void platform.browserPreview?.hide()
        }

        function setBrowserPreviewWidth(next: number) {
          const { current } = getOrInitPanels()
          if (current.browserPreview.width === next) return
          setStore(
            "sessionView",
            key(),
            "panels",
            "browserPreview",
            "width",
            next,
          )
        }

        function setBrowserPreviewUrl(next: string) {
          const { current } = getOrInitPanels()
          if (current.browserPreview.url === next) return
          setStore(
            "sessionView",
            key(),
            "panels",
            "browserPreview",
            "url",
            next,
          )
        }

        return {
          scroll(tab: string) {
            return scroll.scroll(key(), tab)
          },
          setScroll(tab: string, pos: SessionScroll) {
            scroll.setScroll(key(), tab, pos)
          },
          todoCollapsed: {
            get: () => s().todoCollapsed ?? false,
            set(collapsed: boolean) {
              const session = key()
              const current = store.sessionView[session]
              if (!current) {
                setStore("sessionView", session, { scroll: {}, todoCollapsed: collapsed })
              } else {
                setStore("sessionView", session, "todoCollapsed", collapsed)
              }
            },
          },
          terminal: {
            opened: terminalOpened,
            height: createMemo(() => panels().terminal.height),
            open() {
              setTerminalOpened(true)
            },
            close() {
              setTerminalOpened(false)
            },
            toggle() {
              setTerminalOpened(!terminalOpened())
            },
            resize(height: number) {
              setTerminalHeight(height)
            },
          },
          fileTree: {
            opened: createMemo(() => panels().fileTree.opened),
            width: createMemo(() => panels().fileTree.width),
            tab: createMemo(() => panels().fileTree.tab),
            setTab(tab: "changes" | "all") {
              setFileTreeTab(tab)
            },
            open() {
              setFileTreeOpened(true)
            },
            close() {
              setFileTreeOpened(false)
            },
            toggle() {
              setFileTreeOpened(!panels().fileTree.opened)
            },
            resize(width: number) {
              setFileTreeWidth(width)
            },
          },
          session: {
            width: createMemo(() => panels().session.width),
            resize(width: number) {
              setSessionWidth(width)
            },
          },
          browserPreview: {
            opened: createMemo(() => panels().browserPreview.opened),
            width: createMemo(() => panels().browserPreview.width),
            url: createMemo(() => panels().browserPreview.url),
            open() {
              setBrowserPreviewOpened(true)
            },
            close() {
              setBrowserPreviewOpened(false)
            },
            toggle() {
              setBrowserPreviewOpened(!panels().browserPreview.opened)
            },
            resize(width: number) {
              setBrowserPreviewWidth(width)
            },
            setUrl(url: string) {
              setBrowserPreviewUrl(url)
            },
          },
          reviewPanel: {
            opened: reviewPanelOpened,
            source: reviewPanelSource,
            open(source: ReviewPanelSource = "other") {
              setReviewPanelOpened(true, source)
            },
            close() {
              setReviewPanelOpened(false, "other")
            },
            toggle() {
              setReviewPanelOpened(!reviewPanelOpened(), "other")
            },
          },
          review: {
            open: createMemo(() => s().reviewOpen ?? []),
            setOpen(open: string[]) {
              const session = key()
              const next = Array.from(new Set(open))
              const current = store.sessionView[session]
              if (!current) {
                setStore("sessionView", session, {
                  scroll: {},
                  reviewOpen: next,
                })
                return
              }

              if (same(current.reviewOpen, next)) return
              setStore("sessionView", session, "reviewOpen", next)
            },
            openPath(path: string) {
              const session = key()
              const current = store.sessionView[session]
              if (!current) {
                setStore("sessionView", session, {
                  scroll: {},
                  reviewOpen: [path],
                })
                return
              }

              if (!current.reviewOpen) {
                setStore("sessionView", session, "reviewOpen", [path])
                return
              }

              if (current.reviewOpen.includes(path)) return
              setStore("sessionView", session, "reviewOpen", current.reviewOpen.length, path)
            },
            closePath(path: string) {
              const session = key()
              const current = store.sessionView[session]?.reviewOpen
              if (!current) return

              const index = current.indexOf(path)
              if (index === -1) return
              setStore(
                "sessionView",
                session,
                "reviewOpen",
                produce((draft) => {
                  if (!draft) return
                  draft.splice(index, 1)
                }),
              )
            },
            togglePath(path: string) {
              const session = key()
              const current = store.sessionView[session]?.reviewOpen
              if (!current || !current.includes(path)) {
                this.openPath(path)
                return
              }

              this.closePath(path)
            },
          },
        }
      },
      tabs(sessionKey: string | Accessor<string>) {
        const key = createSessionKeyReader(sessionKey, ensureKey)
        const path = createMemo(() => sessionPath(key()))
        const tabs = createMemo(() => store.sessionTabs[key()] ?? { all: [] })
        const normalize = (tab: string) => normalizeSessionTab(path(), tab)
        const normalizeAll = (all: string[]) => normalizeSessionTabList(path(), all)
        return {
          tabs,
          active: createMemo(() => tabs().active),
          all: createMemo(() => tabs().all.filter((tab) => tab !== "review")),
          setActive(tab: string | undefined) {
            const session = key()
            const next = tab ? normalize(tab) : tab
            if (!store.sessionTabs[session]) {
              setStore("sessionTabs", session, { all: [], active: next })
            } else {
              setStore("sessionTabs", session, "active", next)
            }
          },
          setAll(all: string[]) {
            const session = key()
            const next = normalizeAll(all).filter((tab) => tab !== "review")
            if (!store.sessionTabs[session]) {
              setStore("sessionTabs", session, { all: next, active: undefined })
            } else {
              setStore("sessionTabs", session, "all", next)
            }
          },
          async open(tab: string) {
            const session = key()
            const next = nextSessionTabsForOpen(store.sessionTabs[session], normalize(tab))
            setStore("sessionTabs", session, next)
          },
          close(tab: string) {
            const session = key()
            const current = store.sessionTabs[session]
            if (!current) return

            if (tab === "review") {
              if (current.active !== tab) return
              setStore("sessionTabs", session, "active", current.all[0])
              return
            }

            const all = current.all.filter((x) => x !== tab)
            if (current.active !== tab) {
              setStore("sessionTabs", session, "all", all)
              return
            }

            const index = current.all.findIndex((f) => f === tab)
            const next = current.all[index - 1] ?? current.all[index + 1] ?? all[0]
            batch(() => {
              setStore("sessionTabs", session, "all", all)
              setStore("sessionTabs", session, "active", next)
            })
          },
          move(tab: string, to: number) {
            const session = key()
            const current = store.sessionTabs[session]
            if (!current) return
            const index = current.all.findIndex((f) => f === tab)
            if (index === -1) return
            setStore(
              "sessionTabs",
              session,
              "all",
              produce((opened) => {
                opened.splice(to, 0, opened.splice(index, 1)[0])
              }),
            )
          },
        }
      },
    }
  },
})
