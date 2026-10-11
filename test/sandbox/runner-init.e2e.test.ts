import { expect, test } from "bun:test"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { Schema } from "effect"
import { bridgeClient, runnerFixture } from "./harness"

const runnerScript = resolve(import.meta.dir, "../../deploy/sandbox/runner.sh")
const fixtureRepository = "fixture/history"

for (const path of ["initialize", "start source helper"]) {
  test(`runner ${path} preserves full history at the exact source SHA for container-use`, async () => {
    const runner = await runnerFixture()
    const container = `${runner.name}-runner`
    const exec = (...args: string[]) => runner.docker("exec", container, ...args)
    const reset = () =>
      exec("bash", "-c", "rm -rf /workspace/repository; mkdir /workspace/repository")
    let bridge: ReturnType<typeof bridgeClient> | undefined
    try {
      await exec(
        "bash",
        "-c",
        "printf '42\\n' > value.txt; printf '%s\\n' 'set -eu' 'test \"$(cat value.txt)\" = 42' 'printf runner-init-tests-passed' > verify.sh; git add .; git commit -m task",
      )
      const sourceSha = await exec("git", "rev-parse", "HEAD")
      await exec("bash", "-c", "printf later > later.txt; git add .; git commit -m later")
      await exec("git", "clone", "--bare", "/workspace/repository", "/tmp/history.git")
      await exec(
        "git",
        "config",
        "--global",
        "url.file:///tmp/history.git.insteadOf",
        `https://github.com/${fixtureRepository}.git`,
      )
      await reset()

      // This is the old fetch depth, through real Git/SSH/container-use/Dagger.
      await exec("git", "clone", "--depth=1", "file:///tmp/history.git", "/workspace/repository")
      bridge = bridgeClient(runner.transport)
      await bridge.initialize()
      await bridge.request("tools/list")
      const shallow = await bridge.request("tools/call", {
        name: "environment_create",
        arguments: {
          environment_source: "/workspace/repository",
          title: "Shallow failing control",
        },
      })
      expect(JSON.stringify(shallow)).toContain("shallow update not allowed")
      expect(
        Schema.decodeUnknownSync(Schema.Struct({ isError: Schema.Boolean }))(shallow).isError,
      ).toBe(true)
      await bridge.close()
      bridge = undefined
      await reset()

      // Remap only the fixed Docker container name to this fixture. All Git and
      // Docker operations remain real; Git's URL rewrite selects the local origin.
      const docker = Bun.which("docker")
      if (docker === null) throw new Error("Docker unavailable")
      const wrapper = join(runner.root, "docker")
      await writeFile(
        wrapper,
        `#!/bin/bash\nset -euo pipefail\nargs=("$@")\nfor i in "\${!args[@]}"; do\n  if [[ "\${args[i]}" == workflowd-sandbox-tooling ]]; then args[i]=${container}; fi\ndone\nexec ${docker} "\${args[@]}"\n`,
      )
      await chmod(wrapper, 0o700)
      const script = await Bun.file(runnerScript).text()
      const helper = script.slice(
        script.indexOf("clone_source() {"),
        script.indexOf('\ncase "${1:-}"'),
      )
      expect(helper).toContain("git checkout --detach")
      const invoke =
        path === "initialize" ? `bash "$1" initialize` : `${helper}\nclone_source "$2" "$3"`
      const state = join(runner.root, "state")
      await mkdir(state)
      const child = Bun.spawn(
        [
          "systemd-run",
          "--user",
          "--wait",
          "--pipe",
          "--collect",
          "--expand-environment=no",
          `--unit=workflowd-sandbox-init-${crypto.randomUUID()}`,
          "-p",
          "PrivateUsers=yes",
          "-p",
          "TemporaryFileSystem=/run:rw,mode=755",
          "-p",
          "BindPaths=/run/docker.sock:/run/docker.sock",
          "-p",
          `BindPaths=${state}:/run/workflowd-sandbox`,
          "-p",
          "MemoryMax=6G",
          "-p",
          "MemorySwapMax=0",
          `--setenv=PATH=${runner.root}:/usr/bin:/bin`,
          "bash",
          "-c",
          `set -euo pipefail\nprintf '{"repository":"%s"}' "$2" > /run/workflowd-sandbox/identity.json\n${invoke}`,
          "_",
          runnerScript,
          fixtureRepository,
          sourceSha,
        ],
        {
          stdin: new Blob([JSON.stringify({ repository: fixtureRepository, sourceSha })]),
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ status, stderr: status === 0 ? "" : stderr }).toEqual({ status: 0, stderr: "" })
      if (path === "initialize") expect(stdout.trim()).toBe(sourceSha)
      expect(await exec("git", "rev-parse", "HEAD")).toBe(sourceSha)
      expect(await exec("git", "rev-parse", "--is-shallow-repository")).toBe("false")
      expect(await exec("git", "rev-list", "--count", "HEAD")).toBe("2")
      expect(await exec("bash", "-c", "test ! -f later.txt && printf exact-source")).toBe(
        "exact-source",
      )

      bridge = bridgeClient(runner.transport)
      await bridge.initialize()
      await bridge.request("tools/list")
      const created = Schema.decodeUnknownSync(
        Schema.Struct({
          content: Schema.Array(Schema.Struct({ text: Schema.String })),
          isError: Schema.optionalKey(Schema.Boolean),
        }),
      )(
        await bridge.request("tools/call", {
          name: "environment_create",
          arguments: {
            environment_source: "/workspace/repository",
            title: "Initialized repository",
          },
        }),
      )
      expect(created.isError).not.toBe(true)
      const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
        JSON.parse(created.content[0]?.text ?? "null"),
      )
      const result = await bridge.request("tools/call", {
        name: "environment_run_cmd",
        arguments: {
          environment_source: "/workspace/repository",
          environment_id: id,
          command: "sh verify.sh",
        },
      })
      expect(JSON.stringify(result)).toContain("runner-init-tests-passed")
      expect(
        Schema.decodeUnknownSync(Schema.Struct({ isError: Schema.optionalKey(Schema.Boolean) }))(
          result,
        ).isError,
      ).not.toBe(true)
    } finally {
      await bridge?.close()
      await runner.close()
    }
  }, 300000)
}
