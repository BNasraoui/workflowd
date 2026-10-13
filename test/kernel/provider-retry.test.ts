import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCodexWorker } from "../../src/kernel/codex-worker"

for (const mode of ["recover", "exhaust", "tool"] as const)
  test(`one-shot provider retry: ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-retry-"))
    try {
      const binary = join(root, "codex")
      await writeFile(join(root, "prompt"), "do the task")
      await writeFile(
        binary,
        `#!${process.execPath}
const file = Bun.file(${JSON.stringify(join(root, "attempts"))});
const attempt = (await file.exists() ? Number(await file.text()) : 0) + 1;
await Bun.write(file, String(attempt));
const emit = (value) => console.log(JSON.stringify(value));
emit({type: "thread.started", thread_id: "thread-one"});
emit({type: "turn.started"});
if (${JSON.stringify(mode)} === "tool") emit({type: "item.started", item: {type: "command_execution"}});
if (${JSON.stringify(mode)} === "recover" && attempt === 2) {
  if (!process.argv.includes("resume") || !process.argv.includes("thread-one")) process.exit(8);
  emit({type: "item.completed", item: {type: "agent_message", text: "done"}});
  emit({type: "turn.completed", usage: {output_tokens: 1}});
} else {
  emit({type: "turn.failed", error: {message: "Selected model is at capacity. Please try a different model."}});
  process.exitCode = 1;
}
`,
        { mode: 0o700 },
      )
      const result = await runCodexWorker({
        binary,
        directory: root,
        promptFile: join(root, "prompt"),
        resultFile: join(root, "result"),
        eventsFile: join(root, "events"),
        stderrFile: join(root, "stderr"),
        maxOutputBytes: 16000,
        model: null,
      })
      expect(await readFile(join(root, "attempts"), "utf8")).toBe(
        mode === "recover" ? "2" : mode === "exhaust" ? "3" : "1",
      )
      expect(result).toBe(mode === "recover" ? 0 : 1)
      expect(JSON.parse(await readFile(join(root, "result"), "utf8")).exitCode).toBe(result)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 10000)
