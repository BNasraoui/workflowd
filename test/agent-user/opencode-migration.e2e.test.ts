import { expect, spyOn, test } from "bun:test"
import * as filesystem from "node:fs/promises"
import { spawnSync } from "node:child_process"
import {
  chmod,
  chown,
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  rename,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { networkInterfaces, tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { credentialReason } from "../../src/agent-host/protocol"
import {
  checkOpenCodeMigration,
  migrateOpenCodeGrants,
} from "../../src/agent-host/opencode-credentials"

function fixtureEnvironment(home: string) {
  return {
    PATH: process.env.PATH!,
    HOME: home,
    XDG_DATA_HOME: join(home, "data"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_STATE_HOME: join(home, "state"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_SERVER_PASSWORD: "synthetic-server",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
  }
}

async function runIsolated(pattern: string) {
  const child = Bun.spawn(
    [
      "unshare",
      ...(process.getuid?.() === 0 ? [] : ["--user", "--map-root-user"]),
      "--pid",
      "--fork",
      "--mount-proc",
      "--net",
      "/bin/sh",
      "-c",
      'mount -t tmpfs -o mode=1777 tmpfs /tmp && ip link set lo up && exec "$@"',
      "fixture",
      process.execPath,
      "test",
      import.meta.filename,
      "--test-name-pattern",
      pattern,
    ],
    { stdout: "inherit", stderr: "inherit" },
  )
  expect(await child.exited).toBe(0)
}

/** All client configuration, grants and responses are invented fixture data. */
test("installed OpenCode moves grants, restarts one store, and attaches without copying refresh credentials", async () => {
  const isRoot = process.getuid?.() === 0
  const egressDenied = Object.values(networkInterfaces())
    .flat()
    .every((entry) => entry?.internal)
  if (!isRoot || !egressDenied) {
    await runIsolated("^installed OpenCode")
    return
  }
  const ownUid = process.getuid!()
  const root = await mkdtemp(join(tmpdir(), "opencode-migration-"))
  const ben = Number(process.env.WORKFLOWD_AGENT_TEST_BEN_UID ?? ownUid)
  const agent = Number(process.env.WORKFLOWD_AGENT_TEST_AGENT_UID ?? ownUid)
  const group = Number(process.env.WORKFLOWD_AGENT_TEST_AUTH_GID ?? process.getgid!())
  await chown(root, ownUid, group)
  await chmod(root, 0o710)
  let modelRequests = 0
  let migratedGrantUsed = false
  let refreshes = 0
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      if (path === "/auth/device/token") {
        const body = Schema.decodeUnknownSync(
          Schema.Struct({ grant_type: Schema.String, refresh_token: Schema.String }),
        )(await request.json())
        expect(body.grant_type).toBe("refresh_token")
        expect(body.refresh_token).toBe("synthetic-refresh")
        refreshes++
        return Response.json({
          access_token: "synthetic-rotated-access",
          refresh_token: "synthetic-rotated-refresh",
          expires_in: 3600,
        })
      }
      if (path === "/api/v2/config") return Response.json({ providers: {} })
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
  const binary = Bun.which("opencode2")!
  const running = new Set<ReturnType<typeof Bun.spawn>>()
  const start = async (home: string, uid: number) => {
    const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    const port = reserve.port!
    await reserve.stop(true)
    const child = Bun.spawn(
      asUser(uid, [binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)]),
      { cwd: home, env: fixtureEnvironment(home), stdout: "ignore", stderr: "ignore" },
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
        { cwd: home, env: fixtureEnvironment(home), timeout: 20000, stdio: "ignore" },
      )
      expect(result.status).toBe(0)
      const database = join(home, "data/opencode/opencode.db")
      await chmod(join(home, "data"), 0o700)
      await chmod(join(home, "data/opencode"), 0o700)
      await chmod(database, 0o600)
      databases.push(database)
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
      sourceUnits: [],
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
        "opencode",
        "fixture",
        JSON.stringify({
          type: "oauth",
          methodID: "device",
          access: "synthetic-access",
          refresh: "synthetic-refresh",
          expires: 1,
          metadata: { server: model.url.toString().replace(/\/$/, "") },
        }),
        "opencode",
        "device",
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
    expect(refreshes).toBe(1)
    const refreshed = new Database(policy.database, { readonly: true })
    expect(
      JSON.parse(
        Schema.decodeUnknownSync(Schema.Struct({ value: Schema.String }))(
          refreshed.query("SELECT value FROM credential WHERE id='synthetic-oauth'").get(),
        ).value,
      ),
    ).toMatchObject({ access: "synthetic-rotated-access", refresh: "synthetic-rotated-refresh" })
    refreshed.close()
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
      env: fixtureEnvironment(homes[0]!),
      stdout: "ignore",
      stderr: "ignore",
    })
    expect(await attached.exited).toBe(0)
    expect(refreshes).toBe(1)
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

test("offline migration resumes its journal and refuses schema drift or a reactivated source", async () => {
  if (process.getuid?.() !== 0 || process.pid !== 1) {
    await runIsolated("^offline migration")
    return
  }
  const root = await mkdtemp(join(tmpdir(), "opencode-offline-"))
  const binary = Bun.which("opencode2")!
  const uid = process.getuid()
  const databasePaths: string[] = []
  try {
    for (const name of ["source", "destination"]) {
      const home = join(root, name)
      await mkdir(home, { mode: 0o700 })
      const child = Bun.spawn(
        [
          "unshare",
          ...(uid === 0 ? [] : ["--user", "--map-root-user"]),
          "--net",
          "/bin/sh",
          "-c",
          'ip link set lo up && exec "$@"',
          "fixture",
          binary,
          "auth",
          "list",
          "--standalone",
        ],
        {
          cwd: home,
          env: fixtureEnvironment(home),
          stdout: "ignore",
          stderr: "ignore",
        },
      )
      expect(await child.exited).toBe(0)
      const database = join(home, "data/opencode/opencode.db")
      await chmod(join(home, "data"), 0o700)
      await chmod(join(home, "data/opencode"), 0o700)
      await chmod(database, 0o600)
      databasePaths.push(database)
    }
    const policy = {
      source: databasePaths[0]!,
      database: databasePaths[1]!,
      journal: join(root, "migration.json"),
      agentUid: uid,
      agentGid: process.getgid!(),
      sourceUnits: [
        { name: "opencode2-server.service", scope: "user" as const, user: "ben" },
        { name: "legacy.service", scope: "system" as const },
      ],
    }
    const grant = JSON.stringify({
      type: "oauth",
      methodID: "oauth",
      access: "synthetic-access",
      refresh: "synthetic-refresh",
      expires: 1,
    })
    const seed = () => {
      const db = new Database(policy.source)
      try {
        db.run(
          "INSERT INTO credential (id,integration_id,label,value,active,time_created,time_updated) VALUES (?,?,?,?,?,?,?)",
          ["synthetic", "fixture", "fixture", grant, 1, 1, 1],
        )
      } finally {
        db.close()
      }
    }
    expect(await checkOpenCodeMigration(policy).then(() => undefined, credentialReason)).toBe(
      "opencode_grant_migration_incomplete",
    )
    await expect(migrateOpenCodeGrants(policy)).rejects.toMatchObject({
      reason: "opencode_grant_migration_incomplete",
    })
    seed()
    await chmod(policy.database, 0o644)
    await expect(migrateOpenCodeGrants(policy)).rejects.toMatchObject({
      reason: "opencode_grant_migration_incomplete",
    })
    await chmod(policy.database, 0o600)
    const destinationDirectory = join(root, "destination/data/opencode")
    const retainedDirectory = `${destinationDirectory}.retained`
    const victimDirectory = join(root, "victim")
    await mkdir(victimDirectory, { mode: 0o700 })
    const victim = join(victimDirectory, "opencode.db")
    const checkpoint = new Database(policy.database)
    checkpoint.run("PRAGMA wal_checkpoint(TRUNCATE)")
    checkpoint.close()
    await copyFile(policy.database, victim)
    const before = await readFile(policy.source)
    const victimBefore = await readFile(victim)
    const originalLstat = filesystem.lstat
    for (const timing of ["parent", "attach", "attach-masked", "consumer"] as const) {
      let extra: filesystem.FileHandle | undefined
      let lateConsumer: ReturnType<typeof Bun.spawn> | undefined
      let replaced = false
      let restored = false
      let observations = 0
      function racedLstat(
        path: import("node:fs").PathLike,
        options?: import("node:fs").StatOptions & { bigint?: false | undefined },
      ): Promise<import("node:fs").Stats>
      function racedLstat(
        path: import("node:fs").PathLike,
        options: import("node:fs").StatOptions & { bigint: true },
      ): Promise<import("node:fs").BigIntStats>
      function racedLstat(
        path: import("node:fs").PathLike,
        options?: import("node:fs").StatOptions,
      ): Promise<import("node:fs").Stats | import("node:fs").BigIntStats>
      async function racedLstat(
        path: import("node:fs").PathLike,
        options?: import("node:fs").StatOptions,
      ) {
        if (timing.startsWith("attach") && replaced && !restored) {
          await rename(destinationDirectory, victimDirectory)
          await rename(retainedDirectory, destinationDirectory)
          restored = true
        }
        const info = await originalLstat(path, options)
        // The fifth absolute-path observation is the final check before ATTACH.
        if (
          path === policy.database &&
          ++observations === (timing === "parent" ? 2 : timing.startsWith("attach") ? 5 : 6)
        ) {
          replaced = true
          if (timing === "attach-masked") extra = await filesystem.open(policy.database, "r")
          if (timing === "consumer") {
            lateConsumer = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" })
          } else {
            await rename(destinationDirectory, retainedDirectory)
            if (timing === "parent") await symlink(victimDirectory, destinationDirectory)
            else await rename(victimDirectory, destinationDirectory)
          }
        }
        return info
      }
      const originalReadlink = filesystem.readlink
      function maskedReadlink(
        path: import("node:fs").PathLike,
        options?: BufferEncoding | import("node:fs").ObjectEncodingOptions | null,
      ): Promise<string>
      function maskedReadlink(
        path: import("node:fs").PathLike,
        options: "buffer" | { encoding: "buffer" },
      ): Promise<Buffer<ArrayBuffer>>
      function maskedReadlink(
        path: import("node:fs").PathLike,
        options?: string | import("node:fs").ObjectEncodingOptions | null,
      ): Promise<string | Buffer<ArrayBuffer>>
      async function maskedReadlink(
        path: import("node:fs").PathLike,
        options?: string | { encoding?: string | null | undefined } | null,
      ) {
        const value =
          extra && path === `/proc/self/fd/${extra.fd}`
            ? policy.database
            : await originalReadlink(path)
        return (typeof options === "object" && options?.encoding === "buffer") ||
          options === "buffer"
          ? Buffer.from(value)
          : value
      }
      const linkRace = spyOn(filesystem, "readlink").mockImplementation(maskedReadlink)
      const race = spyOn(filesystem, "lstat").mockImplementation(racedLstat)
      try {
        await expect(migrateOpenCodeGrants(policy)).rejects.toMatchObject({
          reason: "opencode_grant_migration_incomplete",
        })
        expect(replaced).toBe(true)
        await expect(lstat(policy.journal)).rejects.toMatchObject({ code: "ENOENT" })
        expect(await readFile(policy.source)).toEqual(before)
      } finally {
        race.mockRestore()
        linkRace.mockRestore()
        await extra?.close()
        lateConsumer?.kill()
        await lateConsumer?.exited
        if (timing !== "consumer" && replaced && !restored) {
          if (timing === "parent") await rm(destinationDirectory)
          else await rename(destinationDirectory, victimDirectory)
          await rename(retainedDirectory, destinationDirectory)
        }
      }
      expect(await readFile(victim)).toEqual(victimBefore)
    }
    const { migrateConfiguredOpenCode } = await import("../../deploy/agent-user/migrate-opencode")
    await expect(migrateConfiguredOpenCode(policy)).rejects.toThrow()
    const calls: string[][] = []
    const command = async (args: readonly string[]) => {
      calls.push([...args])
      return {
        stdout: args.includes("is-enabled") ? "masked" : "inactive",
        exitCode: args.includes("is-enabled") ? 1 : 3,
      }
    }
    await expect(
      migrateConfiguredOpenCode(policy, async () => ({ stdout: "enabled", exitCode: 0 })),
    ).rejects.toThrow()
    await expect(
      migrateConfiguredOpenCode(policy, async (args) =>
        args.includes("is-enabled") ? command(args) : { stdout: "active", exitCode: 0 },
      ),
    ).rejects.toThrow()
    calls.length = 0
    await migrateConfiguredOpenCode(policy, command)
    expect(calls).toEqual([
      ["--user", "-M", "ben@", "is-enabled", "opencode2-server.service"],
      ["--user", "-M", "ben@", "is-active", "opencode2-server.service"],
      ["is-enabled", "legacy.service"],
      ["is-active", "legacy.service"],
    ])
    await checkOpenCodeMigration(policy)
    const journal: unknown = JSON.parse(await readFile(policy.journal, "utf8"))
    expect(journal).toEqual({ phase: "moved", ids: ["synthetic"] })
    await writeFile(policy.journal, JSON.stringify({ phase: "prepared", ids: ["synthetic"] }))
    await migrateOpenCodeGrants(policy)
    await checkOpenCodeMigration(policy)
    const destination = new Database(policy.database, { readonly: true })
    try {
      expect(destination.query("SELECT value FROM credential").all()).toEqual([{ value: grant }])
      expect(destination.query("SELECT count(*) AS count FROM session_message").get()).toEqual({
        count: 0,
      })
    } finally {
      destination.close()
    }
    seed()
    await expect(checkOpenCodeMigration(policy)).rejects.toMatchObject({
      reason: "opencode_grant_migration_incomplete",
    })
    await expect(migrateOpenCodeGrants(policy)).rejects.toMatchObject({
      reason: "opencode_grant_migration_incomplete",
    })
    const source = new Database(policy.source)
    source.run("DELETE FROM credential")
    source.run("ALTER TABLE credential ADD COLUMN unknown TEXT")
    source.close()
    await expect(migrateOpenCodeGrants(policy)).rejects.toMatchObject({
      reason: "opencode_grant_migration_incomplete",
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60000)
