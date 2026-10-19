import { describe, expect, test } from "bun:test"

import { isBackgroundReportEntry, isSkippedTimelineMessage } from "@/components/chat/lib/timelineRoles"
import type { Message, Metadata } from "./model"
import { questionAnswerMetadata, readOpenChamberResume } from "./openchamber-resume"

const synthetic = (metadata: Metadata | undefined, text = "agent text"): Message => ({
  id: "msg_s",
  sessionID: "ses_1",
  role: "synthetic",
  time: { created: 9 },
  text,
  metadata,
})

describe("readOpenChamberResume", () => {
  test("reads a restart resume the server sent", () => {
    const message = synthetic({
      source: "openchamber-notice", kind: "restart-resume", trigger: "continue", at: 5, cause: "process-exited",
      tool: { name: "shell", input: "sleep 600" },
    })

    expect(readOpenChamberResume(message)).toEqual({
      source: "openchamber-notice", kind: "restart-resume", trigger: "continue", at: 5, cause: "process-exited",
      tool: { name: "shell", input: "sleep 600" }, text: "agent text", sentAt: 9,
    })
  })

  test("reads the answer to an interrupted question", () => {
    const message = synthetic(questionAnswerMetadata({ cause: "inactivity", at: 7, answers: [{ question: "Color?", answer: "Blue" }] }))

    expect(readOpenChamberResume(message)).toMatchObject({ kind: "question-answer", cause: "inactivity", answers: [{ question: "Color?", answer: "Blue" }] })
  })

  test("is undefined for other synthetic messages and for a user message with the same text", () => {
    expect(readOpenChamberResume(synthetic(undefined))).toBeUndefined()
    expect(readOpenChamberResume(synthetic({ source: "openchamber-session", sessionID: "x", state: "completed" }))).toBeUndefined()
    const user: Message = { id: "msg_u", sessionID: "ses_1", role: "user", time: { created: 1 } }
    expect(readOpenChamberResume(user)).toBeUndefined()
  })

  test("renders as a timeline row that opens a turn, not as hidden plumbing", () => {
    const message = synthetic({ source: "openchamber-notice", kind: "restart-resume", at: 5, cause: "unknown", tool: null })

    expect(isBackgroundReportEntry(message)).toBe(true)
    expect(isSkippedTimelineMessage(message)).toBe(false)
    expect(isSkippedTimelineMessage(synthetic(undefined))).toBe(true)
  })
})
