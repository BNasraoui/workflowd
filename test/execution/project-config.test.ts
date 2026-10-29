import { expect, test } from "bun:test"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { codexProjectArguments, codexProjectConfig } from "../../src/execution/project-config"

test("trust overrides use the canonical worktree even through an alias", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflowd-project-trust-"))
  const alias = `${root}.alias`
  try {
    await symlink(root, alias)
    expect(codexProjectConfig(alias)).toEqual({
      projects: { [root]: { trust_level: "untrusted" } },
    })
    expect(codexProjectArguments(alias)).toEqual([
      "-c",
      `projects={${JSON.stringify(root)}={trust_level="untrusted"}}`,
    ])
  } finally {
    await rm(alias, { force: true })
    await rm(root, { recursive: true, force: true })
  }
})
