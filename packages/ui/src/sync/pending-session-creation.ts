import type { Session } from "@/lib/opencode/model"
import { getRuntimeKey } from "@/lib/runtime-switch"

export class SessionCreationError extends Error {
  readonly name = "SessionCreationError"
  constructor(readonly reason: "creation-failed" | "runtime-changed" | "first-send-failed" | "cancelled", options?: ErrorOptions) {
    const messages = {
      "creation-failed": "Failed to create session",
      "runtime-changed": "Message was not sent because the runtime changed.",
      "first-send-failed": "Failed to send message",
      "cancelled": "Failed to send message",
    } as const
    super(messages[reason], options)
  }
}

type PendingCreation = {
  readonly ready: Promise<Session>
  readonly isCurrent: () => boolean
  readonly submitted?: Promise<boolean>
  readonly cancellation?: AbortController
}

const pending = new Map<string, PendingCreation>()
const firstSubmissions = new Map<string, PendingCreation>()
const keyFor = (sessionId: string): string => `${getRuntimeKey()}\n${sessionId}`

type DeferredSessionOperation<T> = {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: Error) => void
}

/** Promise.withResolvers is outside the shared UI's ES2022 runtime contract. */
export function deferSessionOperation<T>(): DeferredSessionOperation<T> {
  let completion: Omit<DeferredSessionOperation<T>, "promise"> | undefined
  const promise = new Promise<T>((resolve, reject) => { completion = { resolve, reject } })
  if (!completion) throw new TypeError("Promise executor did not initialize")
  return { promise, ...completion }
}

/** FORK: pending lifetime spans every list load, even loads begun after insertion. */
export function trackPendingSessionCreation(sessionId: string, creation: PendingCreation): () => void {
  const key = keyFor(sessionId)
  pending.set(key, creation)
  if (creation.submitted) {
    firstSubmissions.set(key, creation)
    void creation.submitted.then(() => { if (firstSubmissions.get(key) === creation) firstSubmissions.delete(key) })
  }
  return () => { if (pending.get(key) === creation) pending.delete(key) }
}

/** FORK: follow-ups and server queues cannot overtake the first prompt's knowledge/goal preparation. */
export function waitForFirstSessionSubmission(sessionId: string): Promise<Session> | undefined {
  const creation = firstSubmissions.get(keyFor(sessionId))
  return creation?.submitted?.then(async (submitted) => {
    if (!creation.isCurrent()) throw new SessionCreationError("runtime-changed")
    if (!submitted) throw new SessionCreationError("first-send-failed")
    return creation.ready
  })
}

export function isPendingSessionCreation(sessionId: string): boolean {
  const creation = pending.get(keyFor(sessionId))
  return creation?.isCurrent() === true && creation.cancellation?.signal.aborted !== true
}

export function cancelPendingSessionCreation(sessionId: string): boolean {
  const creation = pending.get(keyFor(sessionId))
  if (!creation?.isCurrent() || !creation.cancellation) return false
  creation.cancellation.abort(new SessionCreationError("cancelled"))
  return true
}

/** Capture before awaiting; the continuation must still belong to the creating SDK. */
export function waitForSessionCreation(sessionId: string): Promise<Session> | undefined {
  const creation = pending.get(keyFor(sessionId))
  return creation?.ready.then((session) => {
    if (!creation.isCurrent()) throw new SessionCreationError("runtime-changed")
    return session
  })
}
