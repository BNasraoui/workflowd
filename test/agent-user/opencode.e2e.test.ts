import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createServer } from "node:net"
import { join } from "node:path"
import { Effect } from "effect"
import { OpenCode } from "@opencode-ai/client/effect"
import { FetchHttpClient } from "effect/unstable/http"
import { makeOpenCodeSdkClient, SdkOpenCodeAdapter } from "../../src/opencode/adapter"
import { agentOpenCodeEnvironment } from "../../src/agent-host/opencode-server"

test("agent OpenCode startup retains Git identity and isolates project and controller configuration", () => {
  const settings = {
    WORKFLOWD_AGENT_UID: "61002",
    WORKFLOWD_AGENT_GID: "61000",
    WORKFLOWD_AGENT_HOME: "/var/lib/workflowd-agent",
    WORKFLOWD_AGENT_GIT_NAME: "Fixture Agent",
    WORKFLOWD_AGENT_GIT_EMAIL: "agent@example.test",
    OPENCODE_SERVER_PASSWORD: "synthetic-server",
    OPENCODE_PASSWORD: "synthetic-alias",
    GH_TOKEN: "personal",
    SSH_AUTH_SOCK: "/private/socket",
    OPENCODE_CONFIG: "/private/config",
  }
  const identity = { uid: 61002, gid: 61000, groups: [61000] }
  const env = agentOpenCodeEnvironment(settings, identity)
  expect(env.GIT_AUTHOR_EMAIL).toBe("agent@example.test")
  expect(env.GIT_COMMITTER_EMAIL).toBe("agent@example.test")
  expect(env.HOME).toBe("/var/lib/workflowd-agent")
  expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1")
  expect(env.OPENCODE_CONFIG_PROJECT_DISABLE).toBe("1")
  expect(env.OPENCODE_SERVER_PASSWORD).toBeUndefined()
  expect(env.OPENCODE_PASSWORD).toBeUndefined()
  expect(env.GH_TOKEN).toBeUndefined()
  expect(env.SSH_AUTH_SOCK).toBeUndefined()
  expect(env.OPENCODE_CONFIG).toBeUndefined()
  expect(() => agentOpenCodeEnvironment({})).toThrow()
  for (const invalid of [
    { ...identity, uid: 0 },
    { ...identity, uid: 61001 },
    { ...identity, gid: 61001 },
    { ...identity, groups: [61000, 10] },
  ])
    expect(() => agentOpenCodeEnvironment(settings, invalid)).toThrow("UID or groups")
  expect(
    agentOpenCodeEnvironment({ ...settings, OPENCODE_SERVER_PASSWORD: "" }, identity).HOME,
  ).toBe(settings.WORKFLOWD_AGENT_HOME)
})

test("agent OpenCode service checks migrated sole ownership before starting the agent UID", async () => {
  const unit = await readFile(
    join(import.meta.dir, "../../deploy/systemd/workflowd-agent-opencode.service"),
    "utf8",
  )
  for (const line of [
    "User=workflowd-agent",
    "UnsetEnvironment=OPENCODE_SERVER_PASSWORD OPENCODE_PASSWORD",
    "Group=workflowd-model-auth",
    "ProtectHome=yes",
    "ProtectSystem=strict",
    "CapabilityBoundingSet=",
    "NoNewPrivileges=yes",
    "PrivateTmp=yes",
    "ProtectProc=invisible",
    "Environment=OPENCODE_DISABLE_PROJECT_CONFIG=1",
    "Environment=OPENCODE_CONFIG_PROJECT_DISABLE=1",
    "ExecStartPre=+/usr/local/sbin/workflowd-migrate-opencode --check",
  ])
    expect(unit).toContain(line)
  expect(unit).toContain("-/run/docker.sock -/run/tailscale -/etc/workflowd -/run/credentials")
})

test("OpenCode recovered mailbox prompts refuse before provider I/O when migration admission fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-opencode-refusal-"))
  const socket = join(directory, "admission.sock")
  const host = createServer((connection) =>
    connection.once("data", () =>
      connection.end(
        JSON.stringify({
          admitted: false,
          reason: "opencode_grant_migration_incomplete",
        }) + "\n",
      ),
    ),
  )
  await new Promise<void>((resolve, reject) => {
    host.once("error", reject)
    host.listen(socket, resolve)
  })
  let requests = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++
      return new Response(null, { status: 204 })
    },
  })
  try {
    const adapter = new SdkOpenCodeAdapter(
      makeOpenCodeSdkClient(
        OpenCode.make({ baseUrl: server.url.toString() }).pipe(
          Effect.provide(FetchHttpClient.layer),
        ),
        socket,
      ),
    )
    const result = await Effect.runPromise(
      adapter
        .promptSession({
          sessionID: "ses_fixture",
          directory,
          agent: "build",
          model: { providerID: "fixture", modelID: "fixture" },
          text: "completion",
          delivery: "queue",
        })
        .pipe(Effect.result),
    )
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { cause: { reason: "opencode_grant_migration_incomplete" } },
    })
    expect(requests).toBe(0)
  } finally {
    await server.stop(true)
    await new Promise<void>((resolve) => host.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
