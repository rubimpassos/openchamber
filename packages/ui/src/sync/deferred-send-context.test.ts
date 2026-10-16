import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import type { SyntheticContextInput } from "@/lib/opencode/client"
import { opencodeClient } from "@/lib/opencode/client"
import { useConfigStore } from "@/stores/useConfigStore"
import { ChildStoreManager } from "./child-store"
import { optimisticSend, setActionRefs, setOptimisticRefs } from "./session-actions"
import { SessionMessageLoader } from "./session-message-loader"
import { deferSessionOperation } from "./pending-session-creation"

const directory = "/deferred-context"
const sessionId = "ses_context"
let stores: ChildStoreManager
let loader: SessionMessageLoader
const config = useConfigStore.getState()

beforeEach(() => {
  stores = new ChildStoreManager()
  loader = new SessionMessageLoader(stores, { runtimeKey: "context-test", sdk: {
    getSessionMessages: async () => ({ items: [], cursor: {} }),
  } })
  stores.ensureChild(directory, { bootstrap: false })
  setActionRefs(stores, () => directory)
  setOptimisticRefs((input) => loader.optimisticAdd({ ...input, directory }), (input) => loader.optimisticRemove({ ...input, directory }))
  useConfigStore.setState({ isConnected: true })
})

afterEach(() => {
  loader.dispose()
  stores.disposeAll()
  useConfigStore.setState(config)
})

test("preserves ordered context records and IDs when one context slot is deferred", async () => {
  // Given attached context, delayed response settings, and goal context.
  const style = deferSessionOperation<SyntheticContextInput | null>()
  const submit = spyOn(opencodeClient, "sendMessage").mockResolvedValue("accepted")
  const requests: Array<{ id: string; context: SyntheticContextInput[] }> = []
  // When the prompt is inserted before the middle context slot resolves.
  const sending = optimisticSend({
    sessionId, directory, content: "input",
    leadingContext: Promise.resolve({ text: "k", description: "knowledge" }),
    context: [{ text: "a", description: "attached" }, style.promise, { text: "g", description: "goal" }],
    send: async (id, context) => { requests.push({ id, context }); await opencodeClient.sendMessage({ id: sessionId, providerID: "provider", text: "input", context }) },
  })
  try {
    expect(stores.getChild(directory)?.getState().message[sessionId]?.some((message) => message.role === "user")).toBe(true)
    expect(submit.mock.calls).toHaveLength(0)
    style.resolve({ text: "s", description: "response-style" })
    await sending
    // Then each source remains its own ordered synthetic record before the prompt.
    const request = requests.at(0)
    expect(request?.context.map((item) => item.description)).toEqual(["knowledge", "attached", "response-style", "goal"])
    const ids = request?.context.map((item) => item.id) ?? []
    expect(new Set(ids).size).toBe(4)
    expect(ids).toEqual([...ids].sort())
    expect(ids.every((id) => id && request && id < request.id)).toBe(true)
    expect(stores.getChild(directory)?.getState().message[sessionId]?.map((message) => message.role))
      .toEqual(["synthetic", "synthetic", "synthetic", "synthetic", "user"])
  } finally {
    style.resolve(null)
    submit.mockRestore()
  }
})

test("omits an empty deferred context slot without losing adjacent context", async () => {
  // Given an optional response style that eventually resolves empty.
  const style = deferSessionOperation<SyntheticContextInput | null>()
  let delivered: SyntheticContextInput[] = []
  // When that slot settles after the optimistic insert.
  const sending = optimisticSend({ sessionId, directory, content: "input",
    context: [{ text: "a", description: "attached" }, style.promise, { text: "g", description: "goal" }],
    send: async (_id, context) => { delivered = context },
  })
  style.resolve(null)
  await sending
  // Then the remaining context keeps its separate records and relative order.
  expect(delivered.map((item) => item.description)).toEqual(["attached", "goal"])
  expect(stores.getChild(directory)?.getState().message[sessionId]?.filter((message) => message.role === "synthetic")).toHaveLength(2)
})
