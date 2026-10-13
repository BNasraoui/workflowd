import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmod, chown, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { networkInterfaces, tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import {
  checkOpenCodeMigration,
  migrateOpenCodeGrants,
} from "../../src/agent-host/opencode-credentials"

/** All client configuration, grants and responses are invented fixture data. */
test("installed OpenCode moves grants, restarts one store, and attaches without copying refresh credentials", async () => {
  const isRoot = process.getuid?.() === 0
  const egressDenied = Object.values(networkInterfaces())
    .flat()
    .every((entry) => entry?.internal)
  if (!isRoot || !egressDenied) {
    const child = Bun.spawn(
      [
        "unshare",
        ...(isRoot ? [] : ["--user", "--map-root-user"]),
        "--pid",
        "--fork",
        "--mount-proc",
        "--net",
        "/bin/sh",
        "-c",
        'ip link set lo up && exec "$@"',
        "fixture",
        process.execPath,
        "test",
        import.meta.filename,
      ],
      { stdout: "ignore", stderr: "ignore" },
    )
    expect(await child.exited).toBe(0)
    return
  }
  const ownUid = process.getuid()
  const root = await mkdtemp(join(tmpdir(), "opencode-migration-"))
  const ben = Number(process.env.WORKFLOWD_AGENT_TEST_BEN_UID ?? ownUid)
  const agent = Number(process.env.WORKFLOWD_AGENT_TEST_AGENT_UID ?? ownUid)
  const group = Number(process.env.WORKFLOWD_AGENT_TEST_AUTH_GID ?? process.getgid!())
  await chown(root, ownUid, group)
  await chmod(root, 0o710)
  let modelRequests = 0
  let migratedGrantUsed = false
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      modelRequests++
      migratedGrantUsed ||=
        request.headers.get("authorization") === "Bearer synthetic-existing-grant"
      const chunk = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`
      return new Response(
        chunk({ role: "assistant", content: "synthetic fixture complete" }, null) +
          chunk({}, "stop") +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const homes = [join(root, "source"), join(root, "destination")]
  const asUser = (uid: number, args: string[]) =>
    uid === ownUid
      ? args
      : [
          "/usr/bin/setpriv",
          "--reuid",
          String(uid),
          "--regid",
          String(group),
          "--init-groups",
          ...args,
        ]
  const environment = (home: string) => ({
    PATH: process.env.PATH!,
    HOME: home,
    XDG_DATA_HOME: join(home, "data"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_STATE_HOME: join(home, "state"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_SERVER_PASSWORD: "synthetic-server",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
  })
  const binary = Bun.which("opencode2")!
  const running = new Set<ReturnType<typeof Bun.spawn>>()
  const start = async (home: string, uid: number) => {
    const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    const port = reserve.port!
    await reserve.stop(true)
    const child = Bun.spawn(
      asUser(uid, [binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)]),
      { cwd: home, env: environment(home), stdout: "ignore", stderr: "ignore" },
    )
    running.add(child)
    const url = `http://127.0.0.1:${port}`
    const api = async (path: string, body?: unknown) => {
      const response = await fetch(
        `${url}/api/${path}?${new URLSearchParams({ "location[directory]": home }).toString()}`,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            authorization: `Basic ${Buffer.from("opencode:synthetic-server").toString("base64")}`,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(10000),
        },
      )
      if (!response.ok) throw new Error(`fixture_api_${response.status}`)
      const value: unknown = await response.json()
      return value
    }
    const deadline = Date.now() + 15000
    // The API listens before plugin/config discovery has populated the catalog.
    for (;;) {
      try {
        if (JSON.stringify(await api("model")).includes("fixture")) break
        throw new Error("fixture_model_not_ready")
      } catch {
        if (Date.now() >= deadline) throw new Error("fixture_server_unavailable")
        await Bun.sleep(50)
      }
    }
    expect((await stat(`/proc/${child.pid}`)).uid).toBe(uid)
    return {
      api,
      url,
      stop: async () => {
        child.kill()
        await child.exited
        running.delete(child)
      },
    }
  }
  try {
    const databases = []
    for (const [index, home] of homes.entries()) {
      const uid = index === 0 ? ben : agent
      for (const path of [
        home,
        ...["data", "config", "cache", "state", "config/opencode"].map((name) => join(home, name)),
      ]) {
        await mkdir(path, { recursive: true, mode: 0o700 })
        await chown(path, uid, group)
      }
      await writeFile(
        join(home, "config/opencode/opencode.json"),
        JSON.stringify({
          update: "disable",
          share: "disabled",
          snapshots: false,
          formatter: false,
          lsp: false,
          providers: {
            fixture: {
              package: "aisdk:@ai-sdk/openai-compatible",
              settings: { baseURL: `${model.url.toString()}v1` },
              models: {
                fixture: {
                  capabilities: { tools: true, input: ["text"], output: ["text"] },
                  limit: { context: 100000, output: 1024 },
                },
              },
            },
          },
        }),
      )
      const result = spawnSync(
        asUser(uid, [binary, "auth", "list", "--standalone"])[0]!,
        asUser(uid, [binary, "auth", "list", "--standalone"]).slice(1),
        { cwd: home, env: environment(home), timeout: 20000, stdio: "ignore" },
      )
      expect(result.status).toBe(0)
      databases.push(join(home, "data/opencode/opencode.db"))
    }
    const original = await start(homes[0]!, ben)
    expect(JSON.stringify(await original.api("model")).includes("fixture")).toBe(true)
    await original.api("integration/fixture/connect/key", { key: "synthetic-existing-grant" })
    const policy = {
      source: databases[0]!,
      database: databases[1]!,
      journal: join(root, "migration.json"),
      agentUid: agent,
      agentGid: group,
    }
    await expect(migrateOpenCodeGrants(policy)).rejects.toMatchObject({
      reason: "opencode_grant_migration_incomplete",
    })
    await original.stop()
    const source = new Database(policy.source)
    // Opaque OAuth grant data must survive byte-for-byte; this row tests transport, not provider acceptance.
    source.run(
      "INSERT INTO credential (id,integration_id,label,value,connector_id,method_id,active,time_created,time_updated) VALUES (?,?,?,?,?,?,?,?,?)",
      [
        "synthetic-oauth",
        "fixture-oauth",
        "fixture",
        JSON.stringify({
          type: "oauth",
          methodID: "oauth",
          access: "synthetic-access",
          refresh: "synthetic-refresh",
          expires: 1,
        }),
        "fixture",
        "oauth",
        1,
        1,
        1,
      ],
    )
    source.close()
    await migrateOpenCodeGrants(policy)
    await checkOpenCodeMigration(policy)
    const old = new Database(policy.source, { readonly: true })
    const destination = new Database(policy.database, { readonly: true })
    expect(old.query("SELECT count(*) AS count FROM credential").get()).toEqual({ count: 0 })
    expect(destination.query("SELECT count(*) AS count FROM credential").get()).toEqual({
      count: 2,
    })
    expect(
      JSON.stringify(
        destination.query("SELECT value FROM credential WHERE id='synthetic-oauth'").get(),
      ).includes("synthetic-refresh"),
    ).toBe(true)
    expect(destination.query("SELECT count(*) AS count FROM session_message").get()).toEqual({
      count: 0,
    })
    old.close()
    destination.close()
    await migrateOpenCodeGrants(policy)
    const shared = await start(homes[1]!, agent)
    const session = Schema.decodeUnknownSync(
      Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }),
    )(
      await shared.api("session", {
        agent: "build",
        model: { id: "fixture", providerID: "fixture" },
      }),
    )
    await shared.api(`session/${session.data.id}/prompt`, { text: "synthetic fixture" })
    await shared.api(`session/${session.data.id}/wait`, {})
    expect(modelRequests).toBeGreaterThan(0)
    expect(migratedGrantUsed).toBe(true)
    await shared.stop()
    const restarted = await start(homes[1]!, agent)
    const attached = Bun.spawn(asUser(ben, [binary, "auth", "list", "--server", restarted.url]), {
      cwd: homes[0]!,
      env: environment(homes[0]!),
      stdout: "ignore",
      stderr: "ignore",
    })
    expect(await attached.exited).toBe(0)
    await checkOpenCodeMigration(policy)
    await restarted.stop()
    expect((await stat(policy.database)).uid).toBe(agent)
    expect((await stat(policy.database)).mode & 0o777).toBe(0o600)
    expect((await readFile(policy.journal, "utf8")).includes("synthetic-refresh")).toBe(false)
    const changed = new Database(policy.source)
    changed.run("ALTER TABLE credential ADD COLUMN unknown TEXT")
    changed.close()
    await expect(migrateOpenCodeGrants(policy)).rejects.toMatchObject({
      reason: "opencode_grant_migration_incomplete",
    })
  } finally {
    for (const child of running) {
      child.kill()
      await child.exited
    }
    await model.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 90000)
