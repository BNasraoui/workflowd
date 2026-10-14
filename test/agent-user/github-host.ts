import { expect } from "bun:test"
import {
  chmod,
  chown,
  copyFile,
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { serveCredentialHost } from "../../src/agent-host/server"
import { makeHostCli } from "../../src/agent-host/client"

/** Real root host and system manager; only the model and GitHub endpoints are fixtures. */
export async function publishThroughHost(
  root: string,
  home: string,
  workspace: string,
  uid: number,
  gid: number,
  binary: string,
  env: Record<string, string>,
  identity: NonNullable<Parameters<typeof makeHostCli>[3]>,
) {
  expect(process.getuid!()).toBe(0)
  expect(uid).not.toBe(0)
  const store = join(root, "host-store")
  const custodyRoot = join(root, "host-custody")
  const ioRoot = join(root, "host-io")
  for (const [path, mode] of [
    [store, 0o710],
    [custodyRoot, 0o700],
    [ioRoot, 0o711],
  ] as const) {
    await mkdir(path, { mode })
    await chown(path, 0, gid)
  }
  const login = async (name: string) => {
    const canonical = join(store, name)
    await writeFile(canonical, '{"OPENAI_API_KEY":"fixture-only"}', { mode: 0o660 })
    await chmod(canonical, 0o660)
    await chown(canonical, 0, gid)
    const benLink = join(store, `ben-${name}`)
    const agentLink = join(home, name)
    await symlink(canonical, benLink)
    await symlink(canonical, agentLink)
    return { canonical, benLink, agentLink }
  }
  // Hosted runners may install Bun beneath a writable tool-cache ancestor.
  // Match nativeBoundary's root-owned runtime copy instead of weakening host admission.
  const runtime = join(root, "bun")
  await copyFile(await realpath(process.execPath), runtime)
  await chmod(runtime, 0o755)
  const worker = join(root, "host-worker.js")
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "../../src/kernel/codex-worker.ts")],
    target: "bun",
  })
  expect(build.success).toBe(true)
  await writeFile(worker, await build.outputs[0]!.text(), { mode: 0o644 })
  // Only fixture networking reaches the CLI through this trusted wrapper. Broker
  // identity, token clearing and GH_CONFIG_DIR must come from hostLaunchCommand.
  const network = Object.fromEntries(
    Object.entries(env).filter(([key]) =>
      [
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "NO_PROXY",
        "GIT_SSL_CAINFO",
        "SSL_CERT_FILE",
        "NODE_EXTRA_CA_CERTS",
        "PATH",
      ].includes(key),
    ),
  )
  const script = await readFile(binary, "utf8")
  const newline = script.indexOf("\n") + 1
  await writeFile(
    binary,
    script.slice(0, newline) +
      `Object.assign(process.env, ${JSON.stringify(network)});\n` +
      script.slice(newline),
  )
  const socket = join(root, "host.sock")
  const host = await serveCredentialHost(
    socket,
    {
      root: store,
      ownerUid: 0,
      controllerUid: 0,
      agentUid: uid,
      groupGid: gid,
      codex: await login("auth.json"),
      claude: await login(".credentials.json"),
      consumerExecutables: [],
      launch: {
        custodyRoot,
        ioRoot,
        home,
        workspaceRoot: workspace,
        bun: runtime,
        worker,
        codex: binary,
        claude: binary,
      },
    },
    undefined,
    {
      WORKFLOWD_AGENT_GIT_NAME: "Fixture Agent",
      WORKFLOWD_AGENT_GIT_EMAIL: "agent@example.test",
      WORKFLOWD_AGENT_GIT_BLOCKED_EMAILS: "blocked@example.test",
    },
  )
  try {
    const cli = makeHostCli(socket, "codex", () => ({ type: "other" }), identity)
    const process = await Effect.runPromise(
      cli.spawn({
        runId: "codex",
        directory: workspace,
        prompt: "Execute the fixture shell command and finish.",
        model: null,
      }),
    )
    try {
      const result = await Effect.runPromise(process.exited)
      expect(result).toMatchObject({ exitCode: 0 })
      if (!(await Bun.file(join(workspace, "sha")).exists()))
        throw new Error(await readFile(join(workspace, "publish.log"), "utf8"))
    } finally {
      await Effect.runPromise(process.cancel)
    }
  } finally {
    await host.close()
  }
}
