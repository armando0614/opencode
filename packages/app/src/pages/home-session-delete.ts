import { notifySessionTabsRemoved } from "@/components/titlebar-session-events"
import type { ServerConnection } from "@/context/server"

type HomeSession = {
  id: string
  directory: string
}

type SessionDelete = {
  directory: string
  sessionID: string
}

export async function deleteHomeSession(input: {
  server: ServerConnection.Key
  session: HomeSession
  delete: (value: SessionDelete) => Promise<unknown>
  remove: () => void
  onError?: (error: unknown) => void
}) {
  await input
    .delete({
      directory: input.session.directory,
      sessionID: input.session.id,
    })
    .then(() => {
      input.remove()
      notifySessionTabsRemoved({
        server: input.server,
        directory: input.session.directory,
        sessionIDs: [input.session.id],
      })
    })
    .catch((error) => input.onError?.(error))
}
