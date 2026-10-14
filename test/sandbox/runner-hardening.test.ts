import { expect, test } from "bun:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "../..")

test("boot exposes only a tooling socket and installs both network boundaries before tooling starts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-boot-"))
  try {
    await writeFile(
      join(directory, "docker"),
      `#!/bin/bash
printf '%s\\n' "$*" >> "$CALLS"
case "$1 $2" in
 'build --quiet') echo image ;;
 'network inspect') echo '172.30.0.0/16 172.30.0.1' ;;
 'exec -i') cat >/dev/null ;;
esac
`,
      { mode: 0o755 },
    )
    await writeFile(join(directory, "sudo"), '#!/bin/sh\nprintf "sudo %s\\n" "$*" >> "$CALLS"\n', {
      mode: 0o755,
    })
    const child = Bun.spawn(
      ["bash", `${root}/deploy/sandbox/runner.sh`, "start", "fixture/repo", "a".repeat(40)],
      {
        env: { PATH: `${directory}:/usr/bin:/bin`, CALLS: join(directory, "calls") },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    expect(await child.exited).toBe(0)
    const calls = await Bun.file(join(directory, "calls")).text()
    expect(calls).not.toContain("tcp://")
    expect(calls).toContain("--addr unix:///run/workflowd-engine/engine.sock")
    expect(calls).toContain("--group 65532")
    expect(calls).toContain("--group-add 65532")
    expect(calls).toContain("engine.toml:/etc/dagger/engine.toml:ro")
    expect(calls).toContain("workflowd-sandbox-socket:/run/workflowd-engine")
    expect(calls.indexOf("network.sh host")).toBeLessThan(
      calls.indexOf("--name workflowd-sandbox-engine"),
    )
    expect(calls.indexOf("sh -s -- engine")).toBeLessThan(
      calls.indexOf("--name workflowd-sandbox-tooling"),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("hold starts with an empty OIDC request environment", async () => {
  const source = await Bun.file(`${root}/.github/workflows/agent-sandbox.yml`).text()
  const hold = source.slice(
    source.indexOf("      - name: Hold the lease"),
    source.indexOf("      - name: Upload sealed result"),
  )
  expect(hold).toContain(
    "shell: /usr/bin/env -u ACTIONS_ID_TOKEN_REQUEST_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_URL",
  )
  expect(hold).toContain("run: exec /usr/local/bin/container-use hold")
  expect(hold).toContain("env -u ACTIONS_ID_TOKEN_REQUEST_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_URL")
  const directory = await mkdtemp(join(tmpdir(), "sandbox-hold-env-"))
  try {
    const script = join(directory, "hold.sh")
    await writeFile(
      script,
      `python3 -c 'import os; assert not any(k.startswith("ACTIONS_ID_TOKEN_REQUEST_") for k in os.environ)'`,
    )
    const shell = hold.match(/shell: (.+)/)?.[1]
    if (!shell) throw new Error("Missing hold launcher")
    const child = Bun.spawn(shell.replace("{0}", script).split(" "), {
      env: {
        PATH: "/usr/bin:/bin",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture",
        ACTIONS_ID_TOKEN_REQUEST_URL: "fixture",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await child.exited).toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("tailscaled launcher strips the request credentials before executing the daemon", async () => {
  const source = await Bun.file(`${root}/deploy/sandbox/tailscale.sh`).text()
  const launch = source.match(
    /\/usr\/bin\/env -u ACTIONS_ID_TOKEN_REQUEST_TOKEN[\s\S]*?--state=mem:/,
  )?.[0]
  expect(launch).toBeDefined()
  if (!launch) throw new Error("Missing daemon launcher")
  const directory = await mkdtemp(join(tmpdir(), "sandbox-daemon-env-"))
  try {
    const daemon = join(directory, "tailscaled")
    await writeFile(
      daemon,
      `#!/usr/bin/python3
import os,sys
assert sys.argv[1:]==['--state=mem:']
assert not any(k.startswith('ACTIONS_ID_TOKEN_REQUEST_') for k in os.environ)
print('clean-daemon')
`,
      { mode: 0o755 },
    )
    const child = Bun.spawn(["bash", "-c", launch.replace("/usr/local/bin/tailscaled", daemon)], {
      env: {
        PATH: "/usr/bin:/bin",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture",
        ACTIONS_ID_TOKEN_REQUEST_URL: "fixture",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await child.exited).toBe(0)
    expect((await new Response(child.stdout).text()).trim()).toBe("clean-daemon")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("enrollment passes the ID token on stdin, never in sudo argv", async () => {
  const source = await Bun.file(`${root}/deploy/sandbox/tailscale.sh`).text()
  const script = source.split("python3 - <<'PY'\n")[1]?.split("\nPY")[0]
  if (!script) throw new Error("Missing enrollment script")
  const directory = await mkdtemp(join(tmpdir(), "sandbox-token-"))
  const token = "eyJ-fake-oidc-token"
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ value: token }) })
  try {
    await writeFile(
      join(directory, "sudo"),
      `#!/usr/bin/python3
import json,os,sys
from pathlib import Path
Path(os.environ['CALLS']).write_text(json.dumps(dict(argv=sys.argv,stdin=sys.stdin.read(),env=dict(os.environ))))
sys.exit(int(os.environ['CLIENT_EXIT']))
`,
      { mode: 0o755 },
    )
    for (const status of [0, 1]) {
      const child = Bun.spawn(["python3", "-"], {
        stdin: new Blob([script]),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: `${directory}:/usr/bin:/bin`,
          CALLS: join(directory, "calls"),
          CLIENT_EXIT: String(status),
          ACTIONS_ID_TOKEN_REQUEST_URL: `${server.url.toString()}?fixture=1`,
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-secret",
          SANDBOX_AUDIENCE: "fixture",
          SANDBOX_TAILSCALE_CLIENT_ID: "client",
          GITHUB_RUN_ID: "1",
          GITHUB_RUN_ATTEMPT: "1",
        },
      })
      expect(await child.exited).toBe(status)
      const calls = await Bun.file(join(directory, "calls")).json()
      expect(JSON.stringify(calls.argv)).not.toContain(token)
      expect(calls.argv).toContain("--id-token=file:/dev/stdin")
      expect(calls.stdin).toBe(token)
      expect(calls.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined()
      expect(calls.env.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined()
      expect(await new Response(child.stderr).text()).not.toContain(token)
    }
  } finally {
    await server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
})

test("release logs out even when container cleanup fails and preserves the failure", async () => {
  const source = await Bun.file(`${root}/.github/workflows/agent-sandbox.yml`).text()
  const script = source
    .split("      - name: Release disposable containers")[1]
    ?.split("run: |\n")[1]
    ?.split("\n")
    .filter((line) => line.startsWith("          "))
    .map((line) => line.slice(10))
    .join("\n")
  if (!script) throw new Error("Missing release script")
  const directory = await mkdtemp(join(tmpdir(), "sandbox-release-"))
  try {
    await writeFile(join(directory, "bash"), "#!/bin/sh\nexit 23\n", { mode: 0o755 })
    await writeFile(join(directory, "sudo"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\n', {
      mode: 0o755,
    })
    const child = Bun.spawn(["/bin/bash", "-e", "-c", script], {
      env: { PATH: `${directory}:/usr/bin:/bin`, CALLS: join(directory, "calls") },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await child.exited).toBe(23)
    expect(await Bun.file(join(directory, "calls")).text()).toBe(
      "tailscale logout\nsystemctl stop workflowd-tailscaled\n",
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
