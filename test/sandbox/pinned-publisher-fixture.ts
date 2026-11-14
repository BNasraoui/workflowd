import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

/** Read the approved Git object, never substitute the worktree candidate for it. */
export async function pinnedPublisherFixture(root: string) {
  const staged = process.env.WORKFLOWD_FIXTURE_PINNED_PUBLISHER
  if (!staged) throw new Error("Stage the exact approved source through isolated-fixture.py")
  const directory = join(root, "approved-publisher")
  await mkdir(directory, { mode: 0o700 })
  for (const [name, digest] of Object.entries({
    "publish.mjs": "3bad0669eaa9fdf2729d67a537a38662490578204ea6ff6ee6088c5a0395b518",
    "publication.mjs": "f86af50a370b18969efcf4c5341f18d93370367e487b19e8fc0237b79378e2f7",
    "publication-unicode.json": "8a899fb3efa73ebd0315ac588ec684538aba2f93b87e3311033c73e81b88967d",
    "result.py": "d4e61a80c70c0d1378fed791d2ace8e472710281678034caf84b22b25520b329",
    "casefold.json": "f5bbd123d49b0688f627a5fcf32e1e3ba2fd0393a157b94ae22d3bc5332aafe2",
  })) {
    const bytes = await readFile(join(staged, name))
    if (createHash("sha256").update(bytes).digest("hex") !== digest)
      throw new Error("Approved publisher source unavailable or mismatched")
    await writeFile(join(directory, name), bytes, { mode: 0o400 })
  }
  return join(directory, "publish.mjs")
}
