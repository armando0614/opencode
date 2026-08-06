import { expect, test } from "bun:test"
import { SESSION_TABS_REMOVED_EVENT, readSessionTabsRemovedDetail } from "@/components/titlebar-session-events"
import { deleteHomeSession } from "./home-session-delete"
import type { ServerConnection } from "@/context/server"

const remote = "remote" as ServerConnection.Key

test("deleting a Home session removes its open titlebar tab", async () => {
  let detail: ReturnType<typeof readSessionTabsRemovedDetail>
  let removed = false
  window.addEventListener(
    SESSION_TABS_REMOVED_EVENT,
    (event) => {
      detail = readSessionTabsRemovedDetail(event)
    },
    { once: true },
  )

  await deleteHomeSession({
    server: remote,
    session: { id: "ses_1", directory: "/workspace" },
    delete: async () => undefined,
    remove: () => {
      removed = true
    },
  })

  expect(removed).toBe(true)
  expect(detail).toEqual({ server: remote, directory: "/workspace", sessionIDs: ["ses_1"] })
})

test("reports delete failures without removing the session", async () => {
  const failure = new Error("offline")
  let error: unknown
  let removed = false

  await deleteHomeSession({
    server: remote,
    session: { id: "ses_1", directory: "/workspace" },
    delete: async () => Promise.reject(failure),
    remove: () => {
      removed = true
    },
    onError: (value) => {
      error = value
    },
  })

  expect(error).toBe(failure)
  expect(removed).toBe(false)
})
