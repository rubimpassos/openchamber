import { afterEach, expect, spyOn, test } from "bun:test"
import { opencodeClient } from "@/lib/opencode/client"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { wrapSystemReminder } from "@/lib/systemReminder"
import { useConfigStore } from "@/stores/useConfigStore"
import { useSessionGoalArmStore } from "@/stores/useSessionGoalArmStore"
import { ChildStoreManager } from "./child-store"
import { setActionRefs, setOptimisticRefs } from "./session-actions"
import { useSessionUIStore } from "./session-ui-store"
import { setSyncRefs } from "./sync-refs"
import { deferSessionOperation } from "./pending-session-creation"

const stores = new ChildStoreManager()
const directory = "/response-style-qa"

afterEach(() => {
  stores.disposeAll()
})

test("shows the prompt while response settings load and includes them before sending", async () => {
  // Given a session whose first-send settings are still on the network.
  stores.ensureChild(directory, { bootstrap: false })
  setActionRefs(stores, () => directory)
  setSyncRefs(opencodeClient.getSdkClient(), stores, directory)
  useConfigStore.setState({ isConnected: true, hasEverConnected: true })
  useSessionGoalArmStore.getState().setArmed(false, null)
  const inserted = deferSessionOperation<void>()
  setOptimisticRefs((input) => {
    if (input.message.role === "user") inserted.resolve()
  }, () => undefined)
  const settings = deferSessionOperation<string | null>()
  const send = spyOn(opencodeClient, "sendMessage").mockResolvedValue("msg_style_qa")
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ text: "", signature: "" }))
  const options = {
    target: { runtimeKey: getRuntimeKey(), sessionId: "ses_style_qa", directory },
    responseStyle: settings.promise,
  }

  try {
    // When the message is submitted without waiting for those settings.
    const sending = useSessionUIStore.getState().sendMessage(
      "qa-input", "qa-provider", "qa-model", undefined, undefined,
      undefined, undefined, undefined, "normal", options,
    )
    await inserted.promise
    await new Promise<void>((resolve) => setImmediate(resolve))

    // Then the bubble is present, but delivery still preserves its context.
    expect(send.mock.calls).toHaveLength(0)
    const style = "qa-response-setting"
    settings.resolve(style)
    await sending
    expect(send.mock.calls).toHaveLength(1)
    expect(send.mock.calls[0]?.[0].context?.map((item) => item.text)).toContain(wrapSystemReminder(style))
  } finally {
    settings.resolve(null)
    send.mockRestore()
    fetch.mockRestore()
  }
})
