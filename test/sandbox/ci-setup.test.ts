import { expect, test } from "bun:test"
import { Schema } from "effect"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

test("actual capability CI setup paths contain success, failure and debug workflow-command output", async () => {
  const workflow = Schema.decodeUnknownSync(
    Schema.Struct({
      jobs: Schema.Struct({
        "capability-security": Schema.Struct({
          steps: Schema.Array(
            Schema.Struct({
              name: Schema.String,
              run: Schema.optionalKey(Schema.String),
            }),
          ),
        }),
      }),
    }),
  )(Bun.YAML.parse(await Bun.file(".github/workflows/ci.yml").text()))
  const names = [
    "Install dependencies",
    "Prepare disposable fixture namespace",
    "Prepare pinned fixture-only tools",
  ]
  const steps = workflow.jobs["capability-security"].steps.filter((step) =>
    names.includes(step.name),
  )
  expect(steps).toHaveLength(3)
  const root = await mkdtemp(join(tmpdir(), "ci-setup-"))
  try {
    const bin = join(root, "bin")
    await mkdir(bin)
    const shim = join(root, "shim.py")
    await writeFile(
      shim,
      `#!/usr/bin/python3
import json,os,pathlib,subprocess,sys
name=pathlib.Path(sys.argv[0]).name
with open(os.environ['FIXTURE_CALLS'],'a') as log: log.write(json.dumps([name,*sys.argv[1:]])+'\\n')
canary='fixture-setup-canary\\n::error::fixture-setup-canary\\n::add-mask::fixture-setup-canary\\nMULTILINE<<EOF\\nfixture-setup-canary\\nEOF'
print(canary); print(canary,file=sys.stderr)
for key in ['GITHUB_OUTPUT','GITHUB_ENV','GITHUB_PATH','GITHUB_STATE','GITHUB_STEP_SUMMARY']:
 if key in os.environ:
  with open(os.environ[key],'a') as out: out.write(canary)
if os.environ['FIXTURE_FAILURE']=='1': sys.exit(1)
if name=='curl': pathlib.Path(sys.argv[sys.argv.index('-o')+1]).write_text('fixture')
if name=='systemd-run': sys.exit(subprocess.run(sys.argv[sys.argv.index('cargo'):]).returncode)
`,
    )
    await chmod(shim, 0o700)
    for (const name of ["bun", "sudo", "git", "systemd-run", "cargo", "curl", "sha256sum", "tar"])
      await symlink(shim, join(bin, name))
    for (const [index, step] of steps.entries())
      for (const fail of [false, true]) {
        const directory = join(root, `${index}-${fail}`)
        await mkdir(directory)
        const child = Bun.spawn(["/bin/bash", "-e", "-o", "pipefail", "-c", step.run!], {
          cwd: resolve("."),
          stdout: "pipe",
          stderr: "pipe",
          env: {
            PATH: `${bin}:/opt/wfd-fixture/bin:/usr/bin:/bin`,
            USER: "fixture",
            RUNNER_TEMP: directory,
            TMPDIR: directory,
            ACTIONS_STEP_DEBUG: "true",
            FIXTURE_FAILURE: fail ? "1" : "0",
            FIXTURE_CALLS: join(directory, "calls"),
            GITHUB_OUTPUT: join(directory, "output"),
            GITHUB_ENV: join(directory, "env"),
            GITHUB_PATH: join(directory, "path"),
            GITHUB_STATE: join(directory, "state"),
            GITHUB_STEP_SUMMARY: join(directory, "summary"),
          },
        })
        const timeout = setTimeout(() => child.kill("SIGKILL"), 5000)
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        clearTimeout(timeout)
        expect(code).toBe(fail ? 1 : 0)
        expect(stderr).toBe("")
        expect(JSON.parse(stdout)).toMatchObject({
          stage: "setup",
          outcome: fail ? "failed" : "ok",
        })
        expect(stdout).not.toContain("fixture-setup-canary")
        for (const name of ["output", "env", "path", "state", "summary"])
          expect(await Bun.file(join(directory, name)).exists()).toBe(false)
        const captures = (await readdir(directory)).filter((name) =>
          name.startsWith("workflowd-private-"),
        )
        expect(captures).toHaveLength(1)
        expect(await readFile(join(directory, captures[0]!, "capture.log"), "utf8")).toContain(
          "::add-mask::fixture-setup-canary",
        )
        if (!fail) {
          const calls = await readFile(join(directory, "calls"), "utf8")
          for (const command of [
            ["bun"],
            ["sudo"],
            ["git", "systemd-run", "cargo", "curl", "sha256sum", "tar"],
          ][index]!)
            expect(calls).toContain(`"${command}"`)
        }
      }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15000)
