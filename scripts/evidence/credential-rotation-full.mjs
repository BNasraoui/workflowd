/* global Bun */
// Scratch-only dependencies for exercising the unmodified src/main.ts entrypoint.
import { mkdir, writeFile, chmod } from "node:fs/promises"
import { join } from "node:path"
import { generateKeyPairSync } from "node:crypto"

export async function fullDaemonEnvironment(root, prefix, env, log) {
  const location = { directory: root, project: { id: "scratch", directory: root, canonical: root } }
  const response = (data) => Response.json({ location, data })
  const session = () => ({
    id: "ses_fixture",
    projectID: "scratch",
    cost: 0,
    location: { directory: root },
    tokens: { input: 0, output: 7, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now(), updated: Date.now() },
  })
  const fixture = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname.replace(/^\/api/, "")
      log("opencode-fixture-request", { method: request.method, path })
      if (path === "/agent")
        return response(
          ["build", "pr-reviewer", "pr-fixer"].map((name) => ({
            id: name,
            name,
            mode: "primary",
            hidden: false,
            permissions: [],
            request: { settings: {}, headers: {}, body: {} },
          })),
        )
      if (path === "/model")
        return response([
          {
            providerID: "fixture",
            id: "fixture",
            modelID: "fixture",
            name: "fixture",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            variants: [],
            time: { released: 0 },
            cost: [],
            status: "active",
            enabled: true,
            limit: { context: 10000, output: 1000 },
          },
        ])
      if (path === "/provider")
        return response([{ id: "fixture", name: "fixture", activation: "auto", package: "" }])
      if (path === "/session" && request.method === "POST") return response(session())
      if (/^\/session\/ses_fixture\/(agent|model)$/.test(path))
        return new Response(null, { status: 204 })
      if (path === "/session/ses_fixture/prompt")
        return Response.json({
          data: {
            id: "msg_fixture",
            sessionID: "ses_fixture",
            timeCreated: Date.now(),
            type: "user",
            payload: { text: "route-separation" },
            delivery: "queue",
          },
        })
      if (path === "/session/ses_fixture") return response(session())
      return Response.json({ error: "unknown scratch fixture endpoint" }, { status: 404 })
    },
  })
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port
  await reservation.stop(true)
  const keyPath = join(root, "github.pem")
  await writeFile(
    keyPath,
    generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey,
    { mode: 0o600 },
  )
  const bin = join(root, "bin")
  await mkdir(bin)
  // The shim enforces ownership and removes the manager's ambient environment.
  // The launch barrier only delays returning from a successful real systemd-run.
  const shim =
    `#!${process.execPath}\n` +
    `
const args = process.argv.slice(2)
const unit = args.find(x => x.startsWith("--unit="))?.slice(7)
if (!unit?.startsWith(process.env.EVIDENCE_PREFIX)) throw Error("unsafe unit")
await Bun.write(process.env.EVIDENCE_ROOT + "/owned-" + unit, "")
const index = args.indexOf(process.execPath)
if (index < 0) throw Error("missing worker executable")
const clean = ["HOME", "PATH", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"].map(k => k + "=" + process.env[k])
const child = Bun.spawn(["/usr/bin/systemd-run", ...args.slice(0,index), "/usr/bin/env", "-i", ...clean, ...args.slice(index)], { stdout: "inherit", stderr: "inherit" })
const code = await child.exited
if (code === 0 && process.env.EVIDENCE_LAUNCH_BARRIER === "1") {
  await Bun.write(process.env.EVIDENCE_ROOT + "/launch-barrier", "")
  await Bun.sleep(2500)
}
process.exit(code)
`
  await writeFile(join(bin, "systemd-run"), shim)
  await chmod(join(bin, "systemd-run"), 0o700)
  return {
    fixture,
    port,
    env: {
      ...env,
      PATH: `${bin}:${env.PATH}`,
      GITHUB_APP_ID: "1",
      GITHUB_PRIVATE_KEY_PATH: keyPath,
      GITHUB_WEBHOOK_SECRET: env.EVIDENCE_TOKEN,
      OPENCODE_SERVER_PASSWORD: env.EVIDENCE_TOKEN,
      OPENCODE_SERVER_URL: `http://127.0.0.1:${fixture.port}`,
      WORKFLOWD_OPENCODE_ATTACH_URL: `http://127.0.0.1:${fixture.port}`,
      WORKFLOWD_HOST_ID: "evidence59",
      WORKFLOWD_HOST: "127.0.0.1",
      WORKFLOWD_PORT: String(port),
      WORKFLOWD_DATABASE_PATH: join(root, "state.db"),
      WORKFLOWD_WORKTREE_ROOT: join(root, "worktrees"),
      WORKFLOWD_LOCAL_REPOSITORIES: join(root, "repo"),
      WORKFLOWD_MODEL: "fixture/fixture",
      WORKFLOWD_AGENT_RUN_TOKEN: env.EVIDENCE_TOKEN,
      WORKFLOWD_AGENT_RUN_ROUTES: "other=fixture/fixture",
      WORKFLOWD_AGENT_RUN_CODEX_ROUTES: "codex=",
      WORKFLOWD_AGENT_RUN_REPOSITORIES: `scratch=${join(root, "repo")}`,
      WORKFLOWD_AGENT_RUN_CODEX_UNIT_PREFIX: prefix,
      WORKFLOWD_AGENT_RUN_VERIFY_POLL_MS: "20",
      WORKFLOWD_AGENT_RUN_MAX_ATTEMPTS: "1",
      WORKFLOWD_AGENT_RUN_PROGRESS_WINDOW_MS: "120000",
    },
  }
}
