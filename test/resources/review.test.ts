import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dockerBackend, systemdBackend, type Config } from "./backend"
import { owner } from "./owner"
import { reap, type Resource } from "./reaper"

const stale = () => {
  const parts = owner().split(".")
  parts[6] = "0"
  return parts.join(".")
}
function fixture(script: string) {
  const directory = mkdtempSync(join(tmpdir(), "resource-review-"))
  const binary = join(directory, "backend")
  writeFileSync(binary, `#!/bin/sh\n${script}\n`, { mode: 0o700 })
  const config: Config = {
    directory,
    owner: owner(),
    launcher: owner(),
    docker: binary,
    systemctl: binary,
    systemdRun: null,
    env: { ...process.env, REVIEW_ROOT: directory, REVIEW_OWNER: stale() },
  }
  return { directory, config, close: () => rmSync(directory, { recursive: true, force: true }) }
}

test("exit cleanup ignores another dead owner's stuck resource", () => {
  const mine = owner()
  const resources: Resource[] = [
    { kind: "volume", id: "stuck", owner: stale() },
    { kind: "volume", id: "mine", owner: mine },
  ]
  reap(
    {
      list: () => resources,
      remove: (r) => {
        if (r.id === "stuck") throw Error("in use")
        resources.splice(resources.indexOf(r), 1)
      },
    },
    mine,
  )
  expect(resources.map((r) => r.id)).toEqual(["stuck"])
})

test("startup warns about an unremovable volume and still runs the suite", async () => {
  const f = fixture(`
if [ "$1" = --context ]; then shift 2; fi
if [ "$1 $2" = 'volume ls' ]; then echo stuck; fi
if [ "$1 $2" = 'volume inspect' ]; then echo "$REVIEW_OWNER"; fi
if [ "$1 $2" = 'volume rm' ]; then echo 'volume is in use' >&2; exit 1; fi`)
  try {
    writeFileSync(join(f.directory, "docker"), readFileSync(f.config.docker!), { mode: 0o700 })
    const path = join(f.directory, "proof.test.ts")
    writeFileSync(
      path,
      `import {test} from 'bun:test'; test('ran', async()=>{ await Bun.write(process.env.PATH.split(':')[0]+'/used-docker',''); console.error('suite reached'); });`,
    )
    const search = `${f.directory}:${process.env.WORKFLOWD_TEST_ORIGINAL_PATH}`
    const child = Bun.spawn([process.execPath, "test", path], {
      env: { ...f.config.env, PATH: search, WORKFLOWD_TEST_ORIGINAL_PATH: search },
      stdout: "ignore",
      stderr: "pipe",
    })
    const output = await new Response(child.stderr).text()
    expect(await child.exited, output).toBe(0)
    expect(output).toContain("suite reached")
    expect(output).toContain("Startup cleanup warning")
    expect(output).toContain("volume:stuck")
  } finally {
    f.close()
  }
})

test("containers with image-inherited ownership are preserved on inventory and reinspection", () => {
  const f = fixture(`
if [ "$1" = --context ]; then shift 2; fi
if [ "$1 $2" = 'container ls' ]; then echo inherited; fi
if [ "$1 $2" = 'container inspect' ]; then
  if [ "$4" = '{{.Image}}' ]; then echo image-id; else echo "$REVIEW_OWNER"; fi
fi
if [ "$1 $2" = 'image inspect' ]; then echo "$REVIEW_OWNER"; fi
if [ "$2" = rm ]; then touch "$REVIEW_ROOT/removed"; fi`)
  try {
    const backend = dockerBackend(f.config)
    expect(backend.list()).toEqual([])
    backend.remove({ kind: "container", id: "inherited", owner: stale() })
    expect(existsSync(join(f.directory, "removed"))).toBe(false)
  } finally {
    f.close()
  }
})

test("systemd ownership matches whole decoded Environment entries only", () => {
  const f = fixture(`
if [ "$1" = --user ]; then shift; fi
if [ "$1" = show ]; then
  if [ "$2" = '*' ]; then
    printf 'Id=decoy.service\\nActiveState=active\\nEnvironment="OTHER=note WORKFLOWD_TEST_RESOURCE_RUN=%s"\\n\\nId=owned.service\\nActiveState=active\\nEnvironment="OTHER=escaped \\\\" quote" "WORKFLOWD_TEST_RESOURCE_RUN=%s"\\n' "$REVIEW_OWNER" "$REVIEW_OWNER"
  else printf '"OTHER=note WORKFLOWD_TEST_RESOURCE_RUN=%s"\\n' "$REVIEW_OWNER"; fi
fi
if [ "$1" = stop ]; then touch "$REVIEW_ROOT/removed"; fi`)
  try {
    const backend = systemdBackend(f.config, true)
    expect(backend.list().map((r) => r.id)).toEqual(["owned.service"])
    backend.remove({ kind: "unit", id: "decoy.service", owner: stale() })
    expect(existsSync(join(f.directory, "removed"))).toBe(false)
  } finally {
    f.close()
  }
})

test("owner refuses a PID namespace with the host proc mount", async () => {
  const child = Bun.spawn(
    [
      "unshare",
      "--user",
      "--map-root-user",
      "--pid",
      "--fork",
      process.execPath,
      "-e",
      `import {owner} from ${JSON.stringify(join(import.meta.dir, "owner.ts"))}; owner()`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const output = await new Response(child.stderr).text()
  expect(await child.exited).not.toBe(0)
  expect(output).toContain("PID namespace does not match /proc")
})
