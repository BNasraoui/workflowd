import { expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { Schema } from "effect"
import { launcherConfig, launcherTestPattern, suites } from "../scripts/check-capability-security"

const listed = Object.values(suites).flatMap((cases) => cases.map(([, file]) => file))

test("each launcher test file belongs to a capability suite", async () => {
  // Bun's test discovery skips node_modules; the scratch and VCS trees hold no sources.
  const roots = (await readdir(".", { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && ![".git", ".scratch", "node_modules"].includes(entry.name),
  )
  const launcherFiles = (
    await Promise.all(
      roots.map(async ({ name }) =>
        (await Array.fromAsync(new Bun.Glob(launcherTestPattern).scan(name))).map(
          (file) => `${name}/${file}`,
        ),
      ),
    )
  ).flat()
  expect(launcherFiles.length).toBeGreaterThan(0)
  for (const file of launcherFiles) expect(listed).toContain(file)
})

test("each suite entry names an existing test file under a unique id", async () => {
  for (const file of listed) expect(await Bun.file(file).exists()).toBe(true)
  const ids = Object.values(suites).flatMap((cases) => cases.map(([id]) => id))
  for (const cases of Object.values(suites))
    expect(new Set(cases.map(([id]) => id)).size).toBe(cases.length)
  expect(ids.length).toBeGreaterThan(0)
})

const testSection = (text: string) =>
  Schema.decodeUnknownSync(Schema.Struct({ test: Schema.Record(Schema.String, Schema.Unknown) }))(
    Bun.TOML.parse(text),
  ).test

test("the plain run leaves out exactly the launcher pattern", async () => {
  const plain = testSection(await Bun.file("bunfig.toml").text())
  expect(plain["pathIgnorePatterns"]).toEqual([launcherTestPattern])
})

test("the suites' config keeps every key except the exclusion and the thresholds", async () => {
  const bunfig = await Bun.file("bunfig.toml").text()
  const { pathIgnorePatterns, coverageThreshold, ...rest } = testSection(bunfig)
  expect([pathIgnorePatterns, coverageThreshold]).not.toContain(undefined)
  expect(testSection(launcherConfig(bunfig))).toEqual(rest)
  expect(() => launcherConfig("[test]\n")).toThrow("bunfig.toml launcher keys changed")
})
