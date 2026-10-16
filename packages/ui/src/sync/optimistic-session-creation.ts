import type { Metadata, ModelSelection, Session } from "@/lib/opencode/model"
import { toModelRef } from "@/lib/opencode/model"
import { opencodeClient } from "@/lib/opencode/client"
import { createSessionId } from "@/lib/opencode/ids"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { getSyncChildStores, registerSessionDirectory } from "./sync-refs"
import { getImperativeSessionMessageLoader } from "./session-message-loader"
import { useSessionUIStore } from "./session-ui-store"
import { adoptCreatedSession } from "./session-actions"
import { dropSessionCaches } from "./session-cache"
import { cleanupPersistedSessionState } from "./session-deletion-cleanup"
import { persistSessions } from "./persist-cache"
import { deferSessionOperation, SessionCreationError, trackPendingSessionCreation } from "./pending-session-creation"

type DraftSessionInput = {
  readonly title?: string
  readonly directory: string
  readonly metadata?: Metadata
  readonly model: ModelSelection
  readonly agent?: string
  readonly onCreationFailure?: (session: { sessionId: string; directory: string }) => void
}

export function createOptimisticDraftSession(input: DraftSessionInput, submitted?: Promise<boolean>) {
  const runtimeKey = getRuntimeKey()
  const sdk = opencodeClient.getSdkClient()
  const stores = getSyncChildStores()
  const loader = getImperativeSessionMessageLoader()
  const isCurrent = () => runtimeKey === getRuntimeKey() && sdk === opencodeClient.getSdkClient()
  const now = Date.now()
  const session: Session = {
    id: createSessionId(), directory: input.directory, projectID: "", title: input.title ?? "",
    agent: input.agent, model: toModelRef(input.model), metadata: input.metadata,
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: now, updated: now },
  }
  const completion = deferSessionOperation<Session>()
  const cancellation = new AbortController()
  const release = trackPendingSessionCreation(session.id, { ready: completion.promise, isCurrent, submitted, cancellation })
  const store = stores.ensureChild(input.directory, { bootstrap: false })
  const state = store.getState()
  const revision = (state.sessionRevision ?? 0) + 1
  registerSessionDirectory(session.id, input.directory)
  store.setState({
    session: [...state.session, session].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    sessionRevision: revision,
    sessionEventRevision: { ...state.sessionEventRevision, [session.id]: revision },
    sessionListSource: "live",
  })
  // FORK: initialize coverage before selecting, so navigation cannot GET an uncreated session.
  loader?.initializeCreatedSession({ directory: input.directory, sessionID: session.id })
  useGlobalSessionsStore.getState().upsertSession(session)
  useSessionUIStore.getState().setCurrentSession(session.id, input.directory, "submitted-draft")

  const rollback = (error: SessionCreationError): void => {
    if (isCurrent()) {
      // FORK: recover newer composer text/files before deletion notifies their owners.
      input.onCreationFailure?.({ sessionId: session.id, directory: input.directory })
      for (const [directory, child] of stores.children) {
        const current = child.getState()
        if (!current.session.some((item) => item.id === session.id) && !current.message[session.id]) continue
        const caches = { message: { ...current.message }, part: { ...current.part },
          session_status: { ...current.session_status }, permission: { ...current.permission }, form: { ...current.form } }
        loader?.invalidateSession({ directory, sessionID: session.id })
        dropSessionCaches(caches, [session.id])
        const nextRevision = (current.sessionRevision ?? 0) + 1
        child.setState({ ...caches, session: current.session.filter((item) => item.id !== session.id),
          sessionRevision: nextRevision,
          sessionDeletedRevision: { ...current.sessionDeletedRevision, [session.id]: nextRevision } })
      }
      useGlobalSessionsStore.getState().removeSessions([session.id])
      cleanupPersistedSessionState({ runtimeKey, directory: input.directory, sessionId: session.id })
    }
    completion.reject(error)
  }
  // FORK: cancellation rejects local readiness now; a later create response cannot submit the prompt.
  const cancel = () => rollback(new SessionCreationError("cancelled"))
  cancellation.signal.addEventListener("abort", cancel, { once: true })
  void (async () => {
    try {
      const created = await opencodeClient.createSession({ id: session.id, title: input.title,
        metadata: input.metadata, model: input.model, agent: input.agent }, input.directory)
      if (cancellation.signal.aborted) return
      if (!isCurrent()) throw new SessionCreationError("runtime-changed")
      if (created.id !== session.id) throw new SessionCreationError("creation-failed")
      const confirmed = { ...created, directory: created.directory || input.directory }
      // FORK: move visible messages and loader shadows together before releasing submissions.
      adoptCreatedSession(confirmed, input.directory)
      release()
      persistSessions(confirmed.directory, stores.getChild(confirmed.directory)?.getState().session)
      useGlobalSessionsStore.getState().upsertSession(confirmed)
      useSessionUIStore.getState().markSessionAsOpenChamberCreated(session.id)
      completion.resolve(confirmed)
    } catch (cause) {
      // A lost create response may still mean the server created it. Keep its directory intact.
      if (!cancellation.signal.aborted) {
        rollback(cause instanceof SessionCreationError ? cause : new SessionCreationError(isCurrent() ? "creation-failed" : "runtime-changed", { cause }))
      }
    } finally {
      cancellation.signal.removeEventListener("abort", cancel)
      // A cancelled entry keeps rejecting session operations until create's transport settles.
      release()
    }
  })()
  return { session, ready: completion.promise }
}
