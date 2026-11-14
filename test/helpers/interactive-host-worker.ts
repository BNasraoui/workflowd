// Fixture entrypoint: the production host worker for every profile. Claude profiles
// receive only the fixture's synthetic loopback upstream and pinned real binary.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Schema } from "effect"
import { runHostWorker } from "../../src/kernel/codex-worker"
import { interactiveFixtureEnvironment } from "./interactive-worker"

const inputPath = process.argv[process.argv.indexOf("--host-input") + 1]!
const binary = process.argv[process.argv.indexOf("--binary") + 1]!
const profile = Schema.decodeUnknownSync(Schema.Struct({ profile: Schema.String }))(
  JSON.parse(await readFile(inputPath, "utf8")),
).profile
if (!["claude", "claude-resume"].includes(profile)) {
  process.exitCode = await runHostWorker(inputPath, binary)
} else {
  const config = Schema.decodeUnknownSync(
    Schema.Struct({
      binary: Schema.String,
      baseUrl: Schema.String,
      hostNetns: Schema.String,
      uid: Schema.Number,
      identity: Schema.Record(Schema.String, Schema.String),
    }),
  )(JSON.parse(await readFile(join(dirname(process.argv[1]!), "interactive-input.json"), "utf8")))
  assert.equal(process.getuid!(), config.uid)
  for (const [key, value] of Object.entries(config.identity)) assert.equal(process.env[key], value)
  const env = await interactiveFixtureEnvironment(
    config.binary,
    config.baseUrl,
    process.env.HOME!,
    {
      ...process.env,
      WORKFLOWD_FIXTURE_HOST_NETNS: config.hostNetns,
    },
  )
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  process.exitCode = await runHostWorker(inputPath, config.binary)
}
