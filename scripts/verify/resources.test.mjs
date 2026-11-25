import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createRunResources, validateIsolation } from "./resources.mjs"
import { playOrRetry, runScenario } from "./run.mjs"

const ordinary = { id: "ordinary", title: "ordinary", steps: [] }
const isolated = { ...ordinary, id: "bot", isolation: "stand" }

// External resources own independent data and liveness. A retained lead refuses
// generic reset even after teardown; only a new stand has an empty journal.
const fixture = (t, overrides = {}) => {
  const outDir = mkdtempSync(join(tmpdir(), "verify-resources-"))
  t.after(() => rmSync(outDir, { recursive: true, force: true }))
  const stands = []
  const browsers = []
  const live = new Set()
  const slots = new Set()
  const factories = {
    async acquireSlot() {
      await overrides.slot?.()
      const lease = {}
      slots.add(lease)
      return () => slots.delete(lease)
    },
    async startStand({ onStop }) {
      assert.equal(live.size, 0, "replacement must wait for both old resources to stop")
      const journal = new Set()
      const children = new Set()
      const stand = {
        uiUrl: `http://localhost:${stands.length + 1}`,
        project: `project-${stands.length + 1}`,
        journal,
        resets: 0,
        describe: () => ({ root: stand.project, uiUrl: stand.uiUrl }),
        async reset() {
          assert.ok(live.has(stand), "reset requires a running stand")
          if (journal.has("retained-lead")) throw new Error("403: Bot conversation belongs to its owner")
          journal.clear()
          stand.resets += 1
        },
        trackProcess: (child) => children.add(child),
        async stop() {
          for (const child of children) live.delete(child)
          live.delete(stand)
          await overrides.stopStand?.()
        },
      }
      stands.push(stand)
      live.add(stand)
      onStop(stand.stop)
      await overrides.stand?.(stand)
      return stand
    },
    async startBrowser({ onSpawn }) {
      const browser = {
        storage: new Map(),
        async newPage() {
          assert.ok(live.has(browser), "page requires a running browser")
          return {
            client: { send: async () => {} },
            allowDownloads: async () => {},
            screenshot: async () => {},
            dispose: async () => {},
            consoleErrors: [], sourceUpdates: [],
          }
        },
        async stop() {
          live.delete(browser)
          await overrides.stopBrowser?.()
        },
      }
      browsers.push(browser)
      live.add(browser)
      onSpawn?.(browser)
      await overrides.browser?.(browser)
      return browser
    },
    async warmUp() { await overrides.warmUp?.() },
    async attachKeptStand() { throw new Error("unexpected attachment") },
  }
  const owner = createRunResources({ options: overrides.options ?? {}, outDir, log: () => {} }, factories)
  t.after(async () => {
    await owner.close().catch(() => undefined)
    assert.equal(live.size, 0)
    assert.equal(slots.size, 0)
  })
  return { owner, outDir, stands, browsers, live, slots }
}

test("retained conversations get fresh retries, repeats and a clean following ordinary stand", async (t) => {
  const f = fixture(t)
  const first = await f.owner.acquire(ordinary)
  first.stand.journal.add("ordinary-session")
  assert.equal((await f.owner.acquire(ordinary)).stand, first.stand)
  const attempts = []
  for (let round = 1; round <= 2; round += 1) {
    const result = await playOrRetry(async (outDir) => {
      const running = await f.owner.acquire(isolated)
      const result = await runScenario({ scenario: isolated, ...running, outDir, round })
      assert.equal(result.ok, true, result.failure?.message)
      assert.equal(running.browser.storage.size, 0)
      running.stand.journal.add("retained-lead")
      running.browser.storage.set("token", "bot")
      attempts.push(running)
      return attempts.length % 2 === 1 ? { ...result, ok: false, failure: { message: "retry me" } } : result
    }, f.outDir, true)
    assert.equal(result.ok, true)
    assert.ok(result.flaky)
    const kept = JSON.parse(readFileSync(join(f.outDir, "stand.json"), "utf8"))
    assert.equal(kept.root, attempts.at(-1).stand.project)
    assert.equal(kept.isolation, "stand")
  }
  const next = await f.owner.acquire(ordinary)
  assert.equal(next.stand.journal.size, 0)
  assert.equal(next.browser.storage.size, 0)
  assert.equal((await runScenario({ scenario: ordinary, ...next, outDir: f.outDir, round: 1 })).ok, true)
  assert.equal((await f.owner.acquire(ordinary)).stand, next.stand)
  assert.equal(JSON.parse(readFileSync(join(f.outDir, "stand.json"), "utf8")).root, next.stand.project)
  assert.equal(JSON.parse(readFileSync(join(f.outDir, "stand.json"), "utf8")).isolation, undefined)
  assert.equal(new Set(attempts.map(({ stand }) => stand)).size, 4)
  for (const { stand, browser } of attempts) {
    assert.equal(stand.resets, 2, "only warmup and the first scenario reset run on each dedicated stand")
    assert.ok(stand.journal.has("retained-lead"), "teardown must not bypass conversation ownership")
    assert.equal(f.live.has(stand), false)
    assert.equal(f.live.has(browser), false)
  }
  assert.equal(f.slots.size, 1, "one lease covers serial replacements")
  await f.owner.stopBrowser()
  assert.deepEqual([...f.live], [next.stand], "keep leaves only the current stand alive")
  await f.owner.close()
  assert.equal(f.live.size, 0)
  assert.equal(f.slots.size, 0)
})

test("invalid isolation metadata and stand-isolated attachment are refused", async (t) => {
  validateIsolation([ordinary, isolated])
  for (const isolation of ["browser", "", null, false]) {
    assert.throws(() => validateIsolation([{ ...ordinary, isolation }]), /isolation must/)
  }
  assert.throws(() => validateIsolation([ordinary, isolated], true), /--attach cannot/)
  const f = fixture(t, { options: { attach: join(tmpdir(), "must-not-read-stand.json") } })
  assert.throws(() => f.owner.acquire(isolated), /--attach cannot/)
  assert.equal(f.live.size, 0)
})

test("a kept dedicated stand is refused even for an ordinary attached scenario", async (t) => {
  const f = fixture(t)
  const file = join(f.outDir, "kept.json")
  writeFileSync(file, JSON.stringify({ isolation: "stand" }))
  const attached = createRunResources({ options: { attach: file }, outDir: f.outDir, log: () => {} }, {})
  await assert.rejects(attached.acquire(ordinary), /kept stand contains/)
  await attached.close()
})

for (const stage of ["slot", "stand", "browser", "warmUp"]) {
  test(`cancellation during ${stage} startup reaps every admitted resource and releases the slot`, async (t) => {
    const entered = Promise.withResolvers()
    const resume = Promise.withResolvers()
    const stopped = Promise.withResolvers()
    const f = fixture(t, {
      [stage]: async () => { entered.resolve(); await resume.promise },
      stopStand: async () => stopped.resolve(),
    })
    const starting = f.owner.acquire(ordinary)
    const refused = assert.rejects(starting, /Stopped while/)
    await entered.promise
    const closing = f.owner.close()
    if (stage === "stand") await stopped.promise
    resume.resolve()
    await refused
    await closing
    assert.equal(f.live.size, 0)
    assert.equal(f.slots.size, 0)
    await assert.rejects(f.owner.acquire(ordinary), /Stopped while/)
  })
}

for (const stage of ["stand", "browser", "warmUp"]) {
  test(`${stage} failure after admission still cleans all owned resources`, async (t) => {
    const f = fixture(t, { [stage]: async () => { throw new Error("readiness failed") } })
    try {
      await assert.rejects(f.owner.acquire(isolated), /readiness failed/)
    } finally {
      await f.owner.close()
    }
    assert.equal(f.live.size, 0)
    assert.equal(f.slots.size, 0)
  })
}

test("browser cleanup failure cannot skip stand cleanup or slot release", async (t) => {
  const f = fixture(t, { stopBrowser: async () => { throw new Error("Chrome stop failed") } })
  await f.owner.acquire(ordinary)
  await assert.rejects(f.owner.close(), AggregateError)
  assert.equal(f.live.size, 0)
  assert.equal(f.slots.size, 0)
})
