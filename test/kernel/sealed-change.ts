import { chmod, mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { changeBase, type SealedChangeCase } from "./sealed-text-cases"

/**
 * Commits, with `git` in the work tree `dir` of a source, the base of the shared change table
 * (`changeBase`), then the one commit of `item`'s change. Gives the two commits.
 */
export async function commitChange(
  git: (...args: string[]) => Promise<string>,
  dir: string,
  item: SealedChangeCase,
) {
  const write = async (path: string, text: string, executable: boolean) => {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), text)
    await chmod(join(dir, path), executable ? 0o755 : 0o644)
    await git("add", "--", path)
  }
  for (const [path, text] of Object.entries(changeBase)) await write(path, text, false)
  await git("commit", "-q", "-m", "base")
  const base = await git("rev-parse", "HEAD")
  for (const [path, file] of Object.entries(item.change))
    if (file === null) await git("rm", "-q", "--", path)
    else if (typeof file === "string") await write(path, file, false)
    else await write(path, file.text, file.executable)
  await git("commit", "-q", "-m", "change")
  return { base, result: await git("rev-parse", "HEAD") }
}
