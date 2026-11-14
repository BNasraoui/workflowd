import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"

const root = "/tmp/opencode/evidence/native-app"
await mkdir(root, { mode: 0o700 })
for (const [entry, name] of [
  ["test/sandbox/fixtures/native-owned-app.ts", "native-owned-app.mjs"],
  ["src/capability-gateway/noscope-provider.ts", "native-owned-provider.mjs"],
]) {
  const result = await Bun.build({
    entrypoints: [entry!],
    target: "bun",
    outdir: root,
    naming: name!,
  })
  if (!result.success)
    throw new AggregateError(result.logs, "Native application fixture build failed")
}
const sources: Record<string, string> = {}
for (const pattern of [
  "src/**/*.ts",
  "deploy/sandbox/*.mjs",
  "test/capability-gateway/fixture.ts",
  "test/sandbox/fixtures/native-owned-app.ts",
  "test/sandbox/harness.ts",
  "test/resources/*.ts",
  "test/sandbox/fixtures/ssh.mjs",
  "test/helpers/fixture-executable.mjs",
  "bun.lock",
  "package.json",
])
  for await (const path of new Bun.Glob(pattern).scan("."))
    sources[path] = createHash("sha256")
      .update(new Uint8Array(await Bun.file(path).arrayBuffer()))
      .digest("hex")
await Bun.write(`${root}/inputs.json`, JSON.stringify(sources, null, 2))
