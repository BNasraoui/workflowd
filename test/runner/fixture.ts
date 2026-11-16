import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * A harness of the run client in place of the box: it reads the launch on its standard input,
 * writes Claude's stream-json lines for it, and leaves `result` (its result.json and its bundle)
 * in the run directory. It names the launch's prompt and model in its lines, so a test sees that
 * the launch reached it.
 */
export async function writeHarness(
  directory: string,
  result: { readonly manifest: string; readonly bundle: Uint8Array } | null,
  options: { readonly extraLines?: number; readonly exitCode?: number } = {},
) {
  const path = join(directory, "harness.mjs")
  if (result !== null) {
    await mkdir(join(directory, "result"), { recursive: true })
    await writeFile(join(directory, "fixture-result.json"), result.manifest)
    await writeFile(join(directory, "fixture-result.bundle"), result.bundle)
  }
  await writeFile(
    path,
    `import { copyFileSync, readFileSync } from "node:fs"
const launch = JSON.parse(readFileSync(0, "utf8"))
const directory = ${JSON.stringify(directory)}
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
line({ type: "system", subtype: "init", session_id: "fixture-session", model: launch.model })
for (let index = 0; index < ${options.extraLines ?? 0}; index++)
  line({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(1000) }] } })
line({ type: "assistant", message: { content: [{ type: "text", text: "prompt: " + launch.prompt + " at " + launch.sourceSha }] } })
line({ type: "result", subtype: "success", is_error: false, result: "Done for " + launch.sourceSha })
${
  result === null
    ? ""
    : `copyFileSync(directory + "/fixture-result.json", directory + "/result/result.json")
copyFileSync(directory + "/fixture-result.bundle", directory + "/result/result.bundle")`
}
process.exitCode = ${options.exitCode ?? 0}
`,
  )
  return path
}
