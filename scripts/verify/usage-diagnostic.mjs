import { mkdirSync, writeFileSync } from "node:fs"
import { Page } from "./browser.mjs"

// Temporary runner-only observation. Buffer events to avoid disk I/O during clicks.
const events = []
const record = (event, fields = {}) => {
  events.push({ event, observedAt: performance.now(), ...fields })
}
const output = "tmp/verify/usage-diagnostic/logs"
process.on("exit", () => {
  mkdirSync(output, { recursive: true })
  writeFileSync(`${output}/usage-trace.jsonl`, events.map((event) => JSON.stringify(event)).join("\n") + "\n")
})

const open = Page.open
Page.open = async function (...args) {
  const page = await open.apply(this, args)
  const pending = new Map()
  const pendingState = () => ({ pendingCount: pending.size, pending: [...pending].map(([requestId, path]) => ({ requestId, path })) })
  const pathOf = (url) => {
    const path = new URL(url).pathname
    return path.startsWith("/api/quota/") ? path : null
  }
  page.client.on("Network.requestWillBeSent", ({ requestId, request, timestamp }) => {
    const path = pathOf(request.url)
    if (!path) return
    pending.set(requestId, path)
    record("quota.start", { requestId, path, timestamp, ...pendingState() })
  })
  page.client.on("Network.responseReceived", ({ requestId, response, timestamp }) => {
    if (!pending.has(requestId)) return
    record("quota.response", { requestId, path: pending.get(requestId), status: response.status, fromDiskCache: response.fromDiskCache, fromServiceWorker: response.fromServiceWorker, timestamp, ...pendingState() })
  })
  page.client.on("Network.loadingFinished", ({ requestId, timestamp }) => {
    const path = pending.get(requestId)
    if (!path) return
    pending.delete(requestId)
    record("quota.finished", { requestId, path, timestamp, ...pendingState() })
  })
  page.client.on("Network.loadingFailed", ({ requestId, timestamp, errorText, blockedReason, canceled }) => {
    const path = pending.get(requestId)
    if (!path) return
    pending.delete(requestId)
    record("quota.failed", { requestId, path, timestamp, errorText, blockedReason, canceled, ...pendingState() })
  })

  const send = page.client.send.bind(page.client)
  const snapshot = (phase) => {
    const queuedAt = performance.now()
    const pendingAtDispatch = pendingState()
    // Queue the read before the mouse command, without awaiting an extra round trip.
    void send("Runtime.evaluate", {
      expression: `(() => {
        const button = document.querySelector('[role="dialog"] button[aria-label="Refresh usage"]')
        return {
          time: performance.now(), timeOrigin: performance.timeOrigin,
          exists: Boolean(button), disabled: button?.disabled,
          ariaDisabled: button?.getAttribute("aria-disabled"),
          pointTargetIsRefresh: globalThis.__verifyPointTarget?.deref() === button,
          refreshing: Boolean(button?.querySelector(".animate-spin"))
        }
      })()`,
      returnByValue: true,
    }).then((result) => {
      record("refresh.snapshot", { phase, queuedAt, pendingAtDispatch, state: result.result?.value, exception: Boolean(result.exceptionDetails) })
    }, (error) => {
      record("refresh.snapshot-error", { phase, queuedAt, message: error instanceof Error ? error.message : String(error) })
    })
  }
  page.client.send = (method, params, options) => {
    if (method === "Network.setBlockedURLs") {
      record("network.block-command", { blocked: params.urls.length > 0, ...pendingState() })
    }
    if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") {
      record("mouse.before-pressed", pendingState())
      snapshot("before-mousePressed")
    }
    const result = send(method, params, options)
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
      // Observe completion without adding another await to the scenario.
      void result.then(() => {
        record("mouse.after-released", pendingState())
        snapshot("after-mouseReleased")
      }, () => record("mouse.release-failed"))
    }
    return result
  }
  return page
}
