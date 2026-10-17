import type { ReactNode } from "react"
import { toast } from "@/components/ui"
import { formatMessage, useI18nStore } from "@/lib/i18n"
import type { OpenchamberNotification } from "@/lib/opencode/events"
import { openSessionFromToast } from "./session-navigation"

const TOAST_ID = "opencode-restart-interrupted"

type InterruptedSession = { sessionId: string; directory: string; title?: string }

type RestartToastOptions = {
  id: string
  duration: number
  description: ReactNode
  action?: { label: string; onClick: () => void }
}

type ShowToast = (title: string, options: RestartToastOptions) => void

/**
 * The sessions the toast can open. Older servers send only `sessionId`; a
 * session without a directory has nothing to open it with.
 */
const interruptedSessions = (notification: OpenchamberNotification, fallbackDirectory: string): InterruptedSession[] => {
  const listed = notification.sessions?.length
    ? notification.sessions
    : notification.sessionId ? [{ sessionId: notification.sessionId, directory: notification.directory }] : []
  return listed.flatMap((session) => {
    const directory = session.directory?.trim() || fallbackDirectory
    return directory ? [{ ...session, directory }] : []
  })
}

/**
 * The toast an OpenCode restart raises when it cut off running turns. One
 * session keeps its single "Open session" action; several are listed by
 * title, each opening its own chat.
 */
export function showRestartInterruptedToast(
  notification: OpenchamberNotification,
  fallbackDirectory: string,
  show: ShowToast = (title, options) => { toast.info(title, options) },
): void {
  const dictionary = useI18nStore.getState().dictionary
  const sessions = interruptedSessions(notification, fallbackDirectory)
  const count = Math.max(notification.sessions?.length ?? 0, sessions.length)

  if (count <= 1) {
    const title = formatMessage(dictionary, "chat.toast.opencodeRestartInterrupted.title")
    const options = {
      id: TOAST_ID,
      description: formatMessage(dictionary, "chat.toast.opencodeRestartInterrupted.description"),
      duration: Infinity,
    }
    const [session] = sessions
    if (!session) {
      show(title, options)
      return
    }
    show(title, {
      ...options,
      action: {
        label: formatMessage(dictionary, "chat.toast.opencodeRestartInterrupted.openSession"),
        onClick: () => openSessionFromToast(session.sessionId, session.directory),
      },
    })
    return
  }

  const untitled = formatMessage(dictionary, "chat.toast.opencodeRestartInterrupted.untitledSession")
  show(formatMessage(dictionary, "chat.toast.opencodeRestartInterrupted.titlePlural", { count }), {
    id: TOAST_ID,
    duration: Infinity,
    description: (
      <div className="flex flex-col gap-1">
        <span>{formatMessage(dictionary, "chat.toast.opencodeRestartInterrupted.descriptionPlural")}</span>
        <ul className="flex flex-col">
          {sessions.map((session) => (
            <li key={session.sessionId}>
              <button
                type="button"
                className="max-w-full truncate text-start text-primary underline-offset-2 hover:underline"
                onClick={() => openSessionFromToast(session.sessionId, session.directory)}
              >
                {session.title || untitled}
              </button>
            </li>
          ))}
        </ul>
      </div>
    ),
  })
}
