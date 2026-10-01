import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCodexWorker, parseCodexWorkerArguments } from "../../src/kernel/codex-worker"

test("Codex exec receives exact native effort and provider with model selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccw2-codex-thinking-"))
  try {
    const binary = join(root, "codex")
    await writeFile(
      binary,
      `#!/usr/bin/env bun\nawait Bun.stdin.text();await Bun.write(${JSON.stringify(join(root, "args.json"))}, JSON.stringify(process.argv.slice(2)));`,
      { mode: 0o700 },
    )
    await writeFile(join(root, "prompt"), "fixture")
    const options = parseCodexWorkerArguments([
      "--binary",
      binary,
      "--directory",
      root,
      "--prompt-file",
      join(root, "prompt"),
      "--result-file",
      join(root, "result"),
      "--events-file",
      join(root, "events"),
      "--stderr-file",
      join(root, "stderr"),
      "--max-output-bytes",
      "1000",
      "--model",
      "native-model",
      "--effort",
      "xhigh",
      "--provider",
      "native-provider",
    ])
    expect(await runCodexWorker(options)).toBe(0)
    expect(JSON.parse(await readFile(join(root, "args.json"), "utf8"))).toEqual([
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--cd",
      root,
      "-m",
      "native-model",
      "-c",
      'model_reasoning_effort="xhigh"',
      "-c",
      'model_provider="native-provider"',
      "-",
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
