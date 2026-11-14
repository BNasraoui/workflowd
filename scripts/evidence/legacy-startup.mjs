/* global Bun */
import { bridgeClient, runnerFixture } from "../../test/sandbox/harness.ts"
import { sandboxSshArguments } from "../../src/sandbox/transport.ts"
import { join } from "node:path"
import { mkdir, readlink } from "node:fs/promises"
import { engineHostBoundaryFixture } from "../../test/sandbox/fixtures/engine-host-boundary.ts"

const runner = await runnerFixture()
let boundary
try {
  const invoke = async (transport) => {
    const child = Bun.spawn([...sandboxSshArguments(transport).slice(0, -1), "true"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    return {
      exit: await child.exited,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    }
  }
  const accepted = await invoke(runner.transport)
  if (accepted.exit !== 0) throw new Error(`Private SSH startup failed: ${accepted.stderr}`)
  const empty = join(runner.root, "empty-known-hosts")
  await Bun.write(empty, "")
  const refused = await invoke({ ...runner.transport, knownHostsFile: empty })
  if (refused.exit === 0 || !refused.stderr.includes("Host key verification failed"))
    throw new Error("Private SSH host-key refusal was not established")
  await Bun.write("/evidence/legacy-startup.json", JSON.stringify({ accepted, refused }))
  if (process.env.WORKFLOWD_FIXTURE_LEGACY_SUITE === "engine-host-boundary") {
    boundary = await engineHostBoundaryFixture(runner)
    const addresses = (await boundary.probe()).split("\n")
    if (addresses.length !== 3 || addresses.some((value) => value !== "02:00:00:00:00:01"))
      throw new Error("Private boundary MAC admission differs")
    await Bun.write(
      "/evidence/legacy-boundary-startup.json",
      JSON.stringify({ ...boundary.custody, addresses }),
    )
  } else if (process.env.WORKFLOWD_SANDBOX_RUNTIME === "1") {
    const client = bridgeClient(runner.transport)
    try {
      await client.initialize()
      await client.request("tools/list")
      const created = await client.request("tools/call", {
        name: "environment_create",
        arguments: {
          environment_source: "/workspace/repository",
          title: "Owned runtime admission",
        },
      })
      await Bun.write("/evidence/legacy-runtime-create.json", JSON.stringify(created))
      const environment = JSON.parse(created.content?.[0]?.text ?? "null")
      if (created.isError || typeof environment?.id !== "string")
        throw new Error("Private environment creation prerequisite failed")
      const nonce = crypto.randomUUID()
      const result = await client.request("tools/call", {
        name: "environment_run_cmd",
        arguments: {
          environment_source: "/workspace/repository",
          environment_id: environment.id,
          command: `test ! -e /var/run/docker.sock && test ! -e /source && pwd && printf '${nonce}' > admission.txt && cat admission.txt`,
        },
      })
      await Bun.write("/evidence/legacy-runtime-execute.json", JSON.stringify(result))
      const text = JSON.stringify(result)
      if (result.isError || !text.includes(nonce) || !text.includes("/workdir"))
        throw new Error("Private nested runtime prerequisite failed")
      const refs = await runner.docker(
        "exec",
        `${runner.name}-runner`,
        "git",
        "for-each-ref",
        "--format=%(refname)",
      )
      if (!refs.includes(`container-use/${environment.id}`))
        throw new Error("Private container-use commit prerequisite failed")
      const state = join(runner.root, "initialization-state")
      await mkdir(state)
      const unit = `workflowd-init-admission-${crypto.randomUUID()}`
      const docker = Bun.which("docker")
      if (docker === null) throw new Error("Missing guarded Docker client")
      const child = Bun.spawn(
        [
          "systemd-run",
          "--user",
          "--wait",
          "--pipe",
          "--collect",
          "--expand-environment=no",
          `--unit=${unit}`,
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
          "-p",
          "TasksMax=512",
          "-p",
          "RuntimeMaxSec=20",
          "/bin/sh",
          "-ec",
          `test -S /run/docker.sock; test ! -S /run/user/0/bus; test ! -r /evidence/daemon.log; test ! -w /work/deploy/sandbox/runner.sh; bash -n /work/deploy/sandbox/runner.sh; printf '${nonce}' > /run/workflowd-sandbox/admission; readlink /proc/self/ns/user; ${JSON.stringify(docker)} info --format '{{.Driver}}'`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      )
      const systemd = {
        exit: await child.exited,
        stdout: await new Response(child.stdout).text(),
        stderr: await new Response(child.stderr).text(),
      }
      await Bun.write("/evidence/legacy-runtime-systemd.json", JSON.stringify(systemd))
      if (systemd.exit !== 0) {
        const journal = Bun.spawn(
          ["journalctl", "--user", `--unit=${unit}`, "--no-pager", "--output=cat", "--lines=30"],
          { stdout: "pipe", stderr: "pipe" },
        )
        await Bun.write(
          "/evidence/legacy-runtime-systemd-journal.json",
          JSON.stringify({
            exit: await journal.exited,
            stdout: await new Response(journal.stdout).text(),
            stderr: await new Response(journal.stderr).text(),
          }),
        )
      }
      if (
        systemd.exit !== 0 ||
        !systemd.stdout.trim().endsWith("overlay2") ||
        systemd.stdout.split("\n")[0] === (await readlink("/proc/self/ns/user")) ||
        (await Bun.file(join(state, "admission")).text()) !== nonce
      )
        throw new Error("Private systemd initialization prerequisite failed")
      await Bun.write(
        "/evidence/legacy-runtime-startup.json",
        JSON.stringify({ created, result, refs, systemd }),
      )
      await Bun.write(
        "/evidence/legacy-origin.log",
        await runner.docker("logs", `${runner.name}-ubuntu`),
      )
    } finally {
      await client.close()
    }
  }
  if (process.env.WORKFLOWD_FIXTURE_LEGACY_DEATH === "1") {
    const uid = process.env.WORKFLOWD_FIXTURE_EVIDENCE_UID
    const gid = process.env.WORKFLOWD_FIXTURE_EVIDENCE_GID
    if (!/^\d+$/.test(uid ?? "") || !/^\d+$/.test(gid ?? ""))
      throw new Error("Missing evidence owner")
    const owner = Bun.spawn(["chown", "-R", `${uid}:${gid}`, "/evidence"], {
      stdout: "ignore",
      stderr: "pipe",
    })
    if ((await owner.exited) !== 0) throw new Error("Private evidence ownership transfer failed")
    await Bun.write("/evidence/legacy-runner-ready", "ready\n")
    await Bun.sleep(120000)
  }
} finally {
  try {
    await boundary?.close()
  } finally {
    await runner.close()
  }
}
