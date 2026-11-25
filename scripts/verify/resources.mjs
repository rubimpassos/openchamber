import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const validateIsolation = (scenarios, attached = false) => {
  for (const scenario of scenarios) {
    if (scenario.isolation !== undefined && scenario.isolation !== "stand") {
      throw new Error(`${scenario.id}: isolation must be "stand" or omitted`)
    }
    if (attached && scenario.isolation === "stand") {
      throw new Error(`${scenario.id}: isolation "stand" requires a fresh owned stand; --attach cannot run it`)
    }
  }
}

/**
 * Owns one admitted stand/browser at a time. Factories retain their process
 * guardians; onStop registers the stand before its asynchronous startup ends.
 */
export const createRunResources = ({ options, outDir, log }, factories) => {
  let active = null
  let dedicated = false
  let generation = 0
  let closed = false
  let pending = null
  let closing = null
  let browser = null
  let browserStarting = null
  let stopStand = async () => undefined
  let stopping = null
  let releaseSlot = null

  const stopBrowser = async () => {
    const running = browser ?? await browserStarting?.catch(() => null)
    browser = null
    browserStarting = null
    await running?.stop()
  }
  const stopAll = () => {
    stopping ??= (async () => {
      try { await stopBrowser() } finally { await stopStand() }
    })().finally(() => { stopping = null })
    return stopping
  }
  const assertOpen = () => {
    if (closed) throw new Error("Stopped while verification resources were starting")
  }
  const start = async (scenario) => {
    const startedAt = Date.now()
    assertOpen()
    if (active && scenario.isolation !== "stand" && !dedicated) return active
    if (active) {
      await stopAll()
      active = null
      stopStand = async () => undefined
      assertOpen()
    }
    if (!options.attach && !releaseSlot) {
      releaseSlot = await factories.acquireSlot({ log })
      assertOpen()
    }
    dedicated = scenario.isolation === "stand"
    const info = options.attach ? JSON.parse(readFileSync(options.attach, "utf8")) : null
    if (info?.isolation === "stand") throw new Error("The kept stand contains a stand-isolated scenario; start a fresh run without --attach")
    generation += 1
    const stand = info
      ? await factories.attachKeptStand(info)
      : await factories.startStand({
        log,
        logsDir: join(outDir, "logs", ...(generation > 1 ? [`stand-${generation}`] : [])),
        onStop: (stop) => { stopStand = stop },
      })
    assertOpen()
    if (!options.attach) {
      writeFileSync(join(outDir, "stand.json"), JSON.stringify({ ...stand.describe(), ...(dedicated ? { isolation: "stand" } : {}) }, null, 2))
    }
    log(`stand ready after ${Math.round((Date.now() - startedAt) / 1000)}s; warming up`)
    browserStarting = factories.startBrowser({ chrome: options.chrome, headed: options.headed, onSpawn: stand.trackProcess })
    browser = await browserStarting
    assertOpen()
    await stand.reset()
    await factories.warmUp({ stand, browser })
    assertOpen()
    active = { stand, browser }
    log(`warmed up after ${Math.round((Date.now() - startedAt) / 1000)}s`)
    return active
  }
  const close = () => {
    closed = true
    closing ??= (async () => {
      const errors = []
      try {
        await stopAll().catch((error) => errors.push(error))
        // An in-flight factory can admit a resource after the first cleanup.
        await pending?.catch(() => undefined)
        await stopAll().catch((error) => errors.push(error))
      } finally {
        releaseSlot?.()
        releaseSlot = null
      }
      if (errors.length) throw new AggregateError(errors, "Verification resource cleanup failed")
    })()
    return closing
  }
  return {
    acquire(scenario) {
      validateIsolation([scenario], Boolean(options.attach))
      pending = start(scenario)
      return pending
    },
    stopBrowser,
    close,
  }
}
