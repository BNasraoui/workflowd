import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

test("the suite fails if the backend refuses to remove a labelled resource", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflowd-resource-failure-"))
  try {
    // A fake CLI is necessary here: injecting an undeletable real resource would
    // violate the very invariant under test. All lifecycle success cases use Docker/systemd.
    await writeFile(
      join(root, "docker"),
      `#!/bin/sh
if [ "$1" = --context ]; then shift 2; fi
if [ "$1 $2" = 'volume ls' ] && [ -f '${root}/owner' ]; then echo retained; fi
if [ "$1 $2" = 'volume inspect' ]; then cat '${root}/owner'; fi
if [ "$1 $2" = 'volume rm' ]; then echo 'injected removal failure' >&2; exit 1; fi
`,
      { mode: 0o755 },
    )
    await writeFile(
      join(root, "proof.test.ts"),
      `
      import { test } from 'bun:test';
      import { owner } from ${JSON.stringify(join(import.meta.dir, "owner.ts"))};
      test('leak', async () => {
        await Bun.write(${JSON.stringify(join(root, "owner"))}, owner());
        await Bun.write(process.env.PATH.split(':')[0]+'/used-docker', '');
      });
    `,
    )
    const path = `${root}:${process.env.WORKFLOWD_TEST_ORIGINAL_PATH}`
    const child = Bun.spawn([process.execPath, "test", join(root, "proof.test.ts")], {
      env: { ...process.env, PATH: path, WORKFLOWD_TEST_ORIGINAL_PATH: path },
      stdout: "ignore",
      stderr: "pipe",
    })
    const output = new Response(child.stderr).text()
    const status = await child.exited
    // Let the guardian finish too: making the fake resource disappear models a
    // subsequent successful removal without altering any real host resources.
    await rm(join(root, "owner"), { force: true })
    const logs = await output
    expect(status, logs).toBe(1)
    expect(logs).toContain("Test resources survived cleanup: volume:retained")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
