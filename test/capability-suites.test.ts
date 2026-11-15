import { expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { Schema } from "effect"
import { gatewayTestDirectory, ownStep, suiteReport, suites } from "../scripts/capability-suites"

/** Test files that only a suite runs; bunfig.toml keeps them out of the plain run. */
const launcherTestPattern = "**/*.launcher.test.ts"

const listed = Object.values(suites).flat()

test("each launcher test file belongs to a capability suite or to a CI step of its own", async () => {
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
  for (const file of launcherFiles)
    expect({ file, runs: listed.includes(file) || file in ownStep }).toEqual({ file, runs: true })
  for (const file of Object.keys(ownStep)) expect(launcherFiles).toContain(file)
})

test("each gateway test file belongs to exactly one suite, or names the job that runs it instead", async () => {
  const files = (await readdir(gatewayTestDirectory))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => `${gatewayTestDirectory}/${name}`)
  expect(files.length).toBeGreaterThan(10)
  for (const file of files)
    expect({ file, suites: listed.filter((entry) => entry === file).length }).toEqual({
      file,
      suites: file in ownStep ? 0 : 1,
    })
  expect(suites["gateway"]).toEqual(
    files.filter((file) => file.endsWith(".e2e.test.ts")).sort((a, b) => a.localeCompare(b)),
  )
})

test("each suite names existing test files, and no file runs in two suites", async () => {
  for (const cases of Object.values(suites)) expect(cases.length).toBeGreaterThan(0)
  for (const file of listed)
    expect({ file, exists: await Bun.file(file).exists() }).toEqual({ file, exists: true })
  expect(new Set(listed).size).toBe(listed.length)
})

test("a suite report counts its cases and names each failed one; a suite of no case fails", () => {
  expect(suiteReport("core", ["a.test.ts", "b.test.ts"], [])).toEqual({
    lines: ["core: 2 cases ran, 0 failed"],
    exitCode: 0,
  })
  expect(suiteReport("core", ["a.test.ts", "b.test.ts"], ["b.test.ts"])).toEqual({
    lines: ["core: 2 cases ran, 1 failed", "failed: b.test.ts"],
    exitCode: 1,
  })
  expect(suiteReport("gateway", [], [])).toEqual({
    lines: ["gateway: 0 cases ran, 0 failed", "failed: gateway holds no case"],
    exitCode: 1,
  })
})

const testSection = (text: string) =>
  Schema.decodeUnknownSync(Schema.Struct({ test: Schema.Record(Schema.String, Schema.Unknown) }))(
    Bun.TOML.parse(text),
  ).test

test("the plain run leaves out exactly the launcher pattern", async () => {
  const plain = testSection(await Bun.file("bunfig.toml").text())
  expect(plain["pathIgnorePatterns"]).toEqual([launcherTestPattern])
})

test("the capability security job runs each suite", async () => {
  const workflow = await Bun.file(".github/workflows/ci.yml").text()
  const matrix = /\n {4}name: Capability security[\s\S]*?\n {8}suite: \[([^\]]*)\]/.exec(
    workflow,
  )?.[1]
  expect(matrix?.split(",").map((suite) => suite.trim())).toEqual(Object.keys(suites))
})

test("one step of the Tests job runs each own-step file, with loopback as its only network", async () => {
  const workflow = Schema.decodeUnknownSync(
    Schema.Struct({
      jobs: Schema.Record(
        Schema.String,
        // A job that calls a reusable workflow has no steps of its own.
        Schema.Struct({
          steps: Schema.optionalKey(
            Schema.Array(Schema.Struct({ run: Schema.optionalKey(Schema.String) })),
          ),
        }),
      ),
    }),
  )(Bun.YAML.parse(await Bun.file(".github/workflows/ci.yml").text()))
  for (const file of Object.keys(ownStep)) {
    const runs = Object.entries(workflow.jobs).flatMap(([job, { steps = [] }]) =>
      steps.flatMap(({ run }) => (run?.includes(file) ? [{ job, run }] : [])),
    )
    expect(runs.map(({ job }) => job)).toEqual(["tests"])
    expect(runs[0]!.run).toStartWith("sudo /usr/bin/unshare --net /bin/sh -c")
    expect(runs[0]!.run).toContain("'ip link set lo up && exec setpriv --reuid=")
  }
})
