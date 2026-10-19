import { afterEach, describe, expect, test } from "bun:test"

import type { JsonValue, Session } from "@/lib/opencode/model"
import { withoutPendingQuestion } from "@/lib/questions/pendingQuestion"
import { replaceGlobalSessionStatusById } from "./global-session-status"
import { listPendingQuestions, syncPendingQuestions, usePendingQuestionsStore } from "./pending-questions"

const session = (id: string, pendingQuestion?: JsonValue): Session => ({
  id, projectID: "p", directory: "/repo", title: id, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  metadata: pendingQuestion ? { openchamber: { pendingQuestion } } : undefined,
})

const question = { messageID: "msg_q", callID: "call_q", title: "Color?", cause: "inactivity", at: 5 }

afterEach(() => {
  usePendingQuestionsStore.setState({ bySession: new Map() })
  replaceGlobalSessionStatusById(new Map())
})

describe("pending questions", () => {
  test("lists a session whose record says a cut-off question waits, and drops it with the record", () => {
    syncPendingQuestions([session("ses_q", question), session("ses_plain")])
    expect(listPendingQuestions()).toEqual([["ses_q", { directory: "/repo", title: "Color?", callID: "call_q" }]])

    syncPendingQuestions([session("ses_q"), session("ses_plain")])
    expect(listPendingQuestions()).toEqual([])
  })

  test("a malformed record, or one from an unknown cause, is no question", () => {
    syncPendingQuestions([session("ses_a", { ...question, callID: "" }), session("ses_b", { ...question, cause: "user" })])
    expect(listPendingQuestions()).toEqual([])
  })

  test("a session running again does not count, even before its record is cleared", () => {
    syncPendingQuestions([session("ses_q", question)])
    replaceGlobalSessionStatusById(new Map([["ses_q", { status: { type: "busy" }, directory: "/repo" }]]))
    expect(listPendingQuestions()).toEqual([])
  })

  test("an unchanged list publishes nothing", () => {
    syncPendingQuestions([session("ses_q", question)])
    const before = usePendingQuestionsStore.getState().bySession
    syncPendingQuestions([session("ses_q", question)])
    expect(usePendingQuestionsStore.getState().bySession).toBe(before)
  })

  test("clearing the record keeps every other metadata key", () => {
    const metadata = { openchamber: { pendingQuestion: question, priority: { at: 1 } }, other: true }
    expect(withoutPendingQuestion(metadata)).toEqual({ openchamber: { priority: { at: 1 } }, other: true })
  })
})
