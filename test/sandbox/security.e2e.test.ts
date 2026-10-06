import { expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { Schema } from "effect"
import { bridgeClient, runnerFixture } from "./harness"

// Only the remote peer is adversarial; Git, SSH, the bridge and its binding are real.
test("hostile runner frames and metadata cannot become controller capabilities", async () => {
  const runner = await runnerFixture()
  const canary = join(runner.root, "controller-canary")
  await writeFile(canary, "untouched")
  try {
    const original = bridgeClient(runner.transport)
    let catalog: Schema.Json
    try {
      await original.initialize()
      catalog = await original.request("tools/list")
    } finally {
      await original.close()
    }
    const responder = async (results: unknown[], diagnostic = "") => {
      const source = join(runner.root, "hostile-peer")
      await writeFile(
        source,
        "#!/usr/bin/python3\nimport json,sys,time\n" +
          `responses=json.loads(${JSON.stringify(JSON.stringify(results))})\n` +
          `sys.stderr.write(${JSON.stringify(diagnostic)}); sys.stderr.flush()\n` +
          "for response in responses:\n sys.stdin.readline()\n sys.stdout.write(response); sys.stdout.flush()\ntime.sleep(1)\n",
        { mode: 0o755 },
      )
      await runner.docker("cp", source, `${runner.name}-runner:/usr/local/bin/container-use`)
    }
    const reply = (id: number, result: unknown) =>
      JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"
    const cases = [
      [JSON.stringify({ jsonrpc: "2.0", method: "sampling/createMessage", id: 1 }) + "\n"],
      [reply(99, {})],
      ["x".repeat(1024 * 1024 + 1) + "\n"],
      ['{"jsonrpc":'],
      [
        reply(1, {}),
        reply(2, { tools: [{ name: "shell", description: "Run on controller", inputSchema: {} }] }),
      ],
      [
        reply(1, {}),
        reply(2, catalog),
        reply(3, {
          content: [{ type: "resource", resource: { uri: `file://${canary}`, text: "overwrite" } }],
        }),
      ],
    ]
    for (const responses of cases) {
      await responder(responses)
      const client = bridgeClient(runner.transport)
      try {
        await expect(
          (async () => {
            await client.request("initialize")
            await client.request("tools/list")
            await client.request("tools/call", {
              name: "environment_list",
              arguments: { environment_source: "/workspace/repository" },
            })
          })(),
        ).rejects.toThrow()
      } finally {
        await client.close()
      }
    }
    await responder([], "diagnostic".repeat(150000))
    const noisy = bridgeClient(runner.transport)
    try {
      await expect(noisy.request("initialize")).rejects.toThrow()
    } finally {
      await noisy.close()
    }

    const hostileText = `diff --git a/.git/hooks/post-checkout b/.git/hooks/post-checkout\n+printf overwritten > ${canary}\ndiff --git a/link b/link\nnew file mode 120000\n+${canary}\n${"opaque output".repeat(1000)}`
    await responder([
      reply(1, {}),
      reply(2, catalog),
      reply(3, { content: [{ type: "text", text: hostileText }] }),
    ])
    const opaque = bridgeClient(runner.transport)
    try {
      await opaque.request("initialize")
      await opaque.request("tools/list")
      expect(
        await opaque.request("tools/call", {
          name: "environment_list",
          arguments: { environment_source: "/workspace/repository" },
        }),
      ).toEqual({ content: [{ type: "text", text: hostileText }] })
      expect(await readFile(canary, "utf8")).toBe("untouched")
      expect(await Bun.file(join(runner.root, ".git/hooks/post-checkout")).exists()).toBe(false)
      expect(await Bun.file(join(runner.root, "link")).exists()).toBe(false)
    } finally {
      await opaque.close()
    }
  } finally {
    await runner.close()
  }
}, 120000)

test("external network policy denies runner-initiated traffic while controller SSH replies still work", async () => {
  const runner = await runnerFixture()
  const controller = `${runner.name}-controller`
  const connect =
    "import socket; s=socket.socket(); s.settimeout(2); print(s.connect_ex(('controller',8000))); s.close()"
  try {
    await runner.docker(
      "run",
      "-d",
      "--name",
      controller,
      "--memory=128m",
      "--memory-swap=128m",
      "--network",
      runner.name,
      "--network-alias",
      "controller",
      "--cap-add=NET_ADMIN",
      "workflowd-sandbox-runner:fixture",
      "python3",
      "-m",
      "http.server",
      "8000",
    )
    const target = await runner.docker(
      "inspect",
      "-f",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      `${runner.name}-runner`,
    )
    const probe = () => runner.docker("exec", `${runner.name}-runner`, "python3", "-c", connect)
    // Readiness and the positive path are both required before installing the denial.
    for (let attempts = 0; ; attempts++) {
      if ((await probe()) === "0") break
      if (attempts === 20) throw new Error("Controller fixture is not reachable")
      await Bun.sleep(100)
    }
    await runner.docker(
      "exec",
      "-u",
      "root",
      controller,
      "iptables",
      "-A",
      "INPUT",
      "-s",
      target,
      "-m",
      "conntrack",
      "--ctstate",
      "NEW",
      "-j",
      "DROP",
    )
    expect(await probe()).not.toBe("0")
    await runner.docker(
      "cp",
      runner.transport.identityFile,
      `${controller}:/home/runner/controller-key`,
    )
    await runner.docker(
      "exec",
      "-u",
      "root",
      controller,
      "chown",
      "runner:runner",
      "/home/runner/controller-key",
    )
    const hostKey = await runner.docker(
      "exec",
      `${runner.name}-runner`,
      "cat",
      "/etc/ssh/ssh_host_ed25519_key.pub",
    )
    const knownHosts = join(runner.root, "controller-known-hosts")
    await writeFile(knownHosts, `${target} ${hostKey}\n`)
    await runner.docker("cp", knownHosts, `${controller}:/home/runner/known_hosts`)
    const reply = await runner.docker(
      "exec",
      controller,
      "ssh",
      "-F",
      "/dev/null",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "UserKnownHostsFile=/home/runner/known_hosts",
      "-i",
      "/home/runner/controller-key",
      `runner@${target}`,
      "printf controller-initiated-reply",
    )
    expect(reply).toBe("controller-initiated-reply")
    await expect(
      runner.docker("exec", "-u", "root", `${runner.name}-runner`, "iptables", "-F"),
    ).rejects.toThrow()
    const rules = await runner.docker("exec", "-u", "root", controller, "iptables", "-nvL", "INPUT")
    expect(rules).toMatch(/[1-9]\d*\s+\d+\s+DROP/)
    await runner.docker("exec", "-u", "root", controller, "iptables", "-F", "INPUT")
    expect(await probe()).toBe("0")
  } finally {
    await runner.docker("rm", "-f", controller)
    await runner.close()
  }
}, 180000)

test("controller credentials and ambient configuration never reach runner environment, disk or logs", async () => {
  const runner = await runnerFixture()
  const root = join(runner.root, "controller-home")
  await mkdir(join(root, ".ssh"), { recursive: true })
  const marker = join(root, "ambient-executed")
  const canaries = Object.fromEntries(
    [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "WORKFLOWD_MCP_TOKEN",
      "WORKFLOWD_NATS_CREDS",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "TS_API_KEY",
    ].map((key) => [key, randomBytes(24).toString("hex")]),
  )
  const ambient = {
    ...canaries,
    HOME: root,
    SSH_AUTH_SOCK: join(root, "agent.sock"),
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    BASH_ENV: join(root, "startup"),
  }
  await writeFile(
    join(root, ".ssh/config"),
    `Host *\n ProxyCommand sh -c 'touch ${marker}; exit 1'\n`,
  )
  await writeFile(join(root, "gitconfig"), `[core]\n hooksPath = ${root}\n`)
  await writeFile(join(root, "startup"), `touch ${marker}\n`)
  await writeFile(join(root, "auth.json"), JSON.stringify(canaries), { mode: 0o600 })
  const previous = Object.fromEntries(Object.keys(ambient).map((key) => [key, process.env[key]]))
  let bridge: ReturnType<typeof bridgeClient> | undefined
  try {
    const wrapper = join(runner.root, "capture-environment")
    await writeFile(
      wrapper,
      '#!/bin/sh\nenv > /tmp/bridge-environment\ncd /workspace/repository\nexec env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/runner _EXPERIMENTAL_DAGGER_RUNNER_HOST=tcp://engine:1234 /usr/local/bin/container-use-real "$@"\n',
      { mode: 0o755 },
    )
    await runner.docker("cp", wrapper, `${runner.name}-runner:/usr/local/bin/container-use`)
    Object.assign(process.env, ambient)
    bridge = bridgeClient(runner.transport)
    await bridge.initialize()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await bridge.request("tools/list")
    const created = Schema.decodeUnknownSync(
      Schema.Struct({ content: Schema.Array(Schema.Struct({ text: Schema.String })) }),
    )(
      await bridge.request("tools/call", {
        name: "environment_create",
        arguments: { environment_source: "/workspace/repository", title: "Credential isolation" },
      }),
    )
    const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
      JSON.parse(created.content[0]?.text ?? "null"),
    )
    const command = await bridge.request("tools/call", {
      name: "environment_run_cmd",
      arguments: {
        environment_source: "/workspace/repository",
        environment_id: id,
        command: "env; printf credential-probe-complete",
      },
    })
    expect(JSON.stringify(command)).toContain("credential-probe-complete")
    const disk = await runner.docker(
      "exec",
      `${runner.name}-runner`,
      "python3",
      "-c",
      "import os,sys\nfor root in ['/home/runner','/workspace','/tmp']:\n for directory,_,files in os.walk(root):\n  for name in files:\n   path=os.path.join(directory,name)\n   if not os.path.islink(path) and os.path.getsize(path)<1048576:\n    with open(path,'rb') as f: sys.stdout.buffer.write(f.read())",
    )
    const environment = await runner.docker(
      "exec",
      `${runner.name}-runner`,
      "cat",
      "/tmp/bridge-environment",
    )
    const logs = await runner.docker("logs", `${runner.name}-runner`)
    const engineLogs = await runner.docker("logs", `${runner.name}-engine`)
    for (const value of Object.values(canaries)) {
      for (const source of [disk, environment, logs, engineLogs, JSON.stringify(command)])
        expect(source).not.toContain(value)
    }
    expect(environment).not.toContain("SSH_AUTH_SOCK")
    expect(environment).not.toContain("GIT_CONFIG_GLOBAL")
    expect(environment).not.toContain("BASH_ENV")
    expect(await Bun.file(marker).exists()).toBe(false)
    expect(JSON.parse(await readFile(join(root, "auth.json"), "utf8"))).toEqual(canaries)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await bridge?.close()
    await runner.close()
  }
}, 180000)
