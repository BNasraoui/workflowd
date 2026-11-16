// The seal of a runner run: the one implementation of the steps between the run's stopped
// workspace and its sealed result, for the harness of the box (native-runner.mjs) and for the
// harnesses of the tests that stand in for the box.
import { mkdir, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { finalMessageText } from "./hidden-text.mjs"
import { command } from "./command.mjs"

const result = fileURLToPath(new URL("./result.py", import.meta.url))

/**
 * The completion of the sealed result. A run in print mode names no title of its own, so the
 * title, the commit message and the body are fixed; the final message is the run's own.
 */
const completion = {
  title: "workflowd agent run",
  commitMessage: "workflowd agent run\n\nThe workspace of one agent run, sealed on its runner.\n",
  body: "The workspace of one agent run, sealed on its runner.",
}

/**
 * Seals the run's workspace with result.py. `native` holds `source.git`, the objects of the
 * source commit `sourceSha` that no agent wrote, and `capture.tar`, the stopped workspace. The
 * final message is the run's `reply` without what the seal refuses in a final message. Leaves
 * `<directory>/result`: result.json and result.bundle, or result.json alone, with the four keys
 * of a sealed result, when the run changed nothing.
 */
export async function sealRun({ directory, native, sourceSha, identity, reply }) {
  const python = (operation, input) =>
    command(operation, "/usr/bin/python3", ["-I", result, ...operation.split(" "), sourceSha], {
      cwd: native,
      input,
      timeoutMs: 300000,
    })
  const finalMessage = finalMessageText(reply)
  // The workspace archive, read by the seal; the run's own .git is never read.
  await python("native-export capture.tar")
  const sealed = JSON.parse(
    await python(
      "native-seal",
      JSON.stringify({ completion: { ...completion, finalMessage }, sensitiveValues: [], identity }),
    ),
  )
  if (sealed.empty === true) {
    // A run that changed nothing: its completion with no bundle, so its caller hears its end.
    const manifest = { sourceSha, title: completion.title, body: completion.body, finalMessage }
    await mkdir(join(directory, "result"), { mode: 0o700 })
    await writeFile(join(directory, "result", "result.json"), JSON.stringify(manifest), {
      mode: 0o600,
      flag: "wx",
    })
    return
  }
  await rename(join(native, "result"), join(directory, "result"))
}
