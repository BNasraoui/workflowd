import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { bundledContractMatchesCanonicalContract } from "../../provenance/qrspi.spec"

const repositoryRoot = join(import.meta.dir, "..", "..")

describe("bundled QRSPI skill reference", () => {
  test("stays generated from the canonical contract", () =>
    bundledContractMatchesCanonicalContract.verify(
      "bundled-contract-hash-match",
      async () => {
        const check = Bun.spawn(["bun", "scripts/sync-qrspi-skill-reference.mjs", "--check"], {
          cwd: repositoryRoot,
          stdout: "pipe",
          stderr: "pipe",
        })
        const [status, stderr] = await Promise.all([
          check.exited,
          new Response(check.stderr).text(),
        ])

        expect(stderr).toBe("")
        expect(status).toBe(0)
      },
      { file: import.meta.path },
    ))
})
