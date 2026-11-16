import { BunRuntime } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { loadCapabilityGatewayConfig } from "./config"
import { makeCapabilityGateway } from "./capability-gateway/service"
import { capabilityApi, serveCapabilityListener } from "./capability-gateway/http"
import type { ClaudeUpstream } from "./capability-gateway/claude"
import type { githubJobKeys } from "./sandbox/bootstrap"
import { gatewayMigrationsTable } from "./capability-control/protocol"
import { storeTables } from "./capability-control/store-tables"
import { runGatewayMigrations } from "./capability-gateway/migrations"
import { serveControl } from "./capability-gateway/control"
import { readSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  checkLogin,
  custodyProvider,
  forbidCoreFiles,
  ImportRefused,
  importLogin,
  loginLimit,
  CustodyRefused,
} from "./capability-gateway/custody"

interface CapabilityGatewayServerOptions {
  readonly upstream?: ClaudeUpstream
  readonly keys?: typeof githubJobKeys
}

/**
 * The capability gateway as its own process, with its own SQLite store: its grants, bindings and
 * tokens survive a restart. workflowd reaches it only on the control socket. A store that holds
 * any table but the gateway's (workflowd's, for one) is refused before anything is written.
 *
 * Three values replace a fixed outside endpoint: `options.upstream` the provider's API,
 * `options.keys` GitHub's job key set, and `gitUpstream` of `makeCapabilityGateway`, which this
 * function leaves at `fetch`, github.com's Git. Only a test gives them, in code. No config key
 * names an endpoint, so no config can send a run's provider credential, proof or Git read to
 * another host.
 */
export const serveCapabilityGateway = (
  env: Record<string, string | undefined>,
  options: CapabilityGatewayServerOptions = {},
) =>
  Effect.gen(function* () {
    // The gateway holds provider values in memory: it, and each process it starts, writes no core.
    yield* Effect.try(forbidCoreFiles)
    const config = yield* Effect.try(() => loadCapabilityGatewayConfig(env))
    if (config.login) {
      const directory = config.login.directory
      const provider = custodyProvider(config.credentialRole)
      if (!provider)
        return yield* Effect.fail(new Error(`custody holds no provider ${config.credentialRole}`))
      // The login directory has one source, `login.directory`: noscope's provider names it.
      const named = yield* Effect.tryPromise({
        try: () => providerAccessDirectory(config.noscope.configHome),
        catch: () => new Error("the noscope provider provider-access does not read"),
      })
      if (named !== directory)
        return yield* Effect.fail(
          new Error(
            `the noscope provider provider-access names ${named ?? "no directory"}, not the login directory ${directory}`,
          ),
        )
      // A login whose directory or file has another owner or a wider mode is refused at start.
      yield* Effect.tryPromise({
        try: () => checkLogin(directory, provider),
        catch: (error) => (error instanceof CustodyRefused ? error : new Error("custody refused")),
      })
    }
    // A file with a table that is not the gateway's is another store: it is read read only and
    // refused before the gateway opens it for writing.
    const tables = yield* Effect.tryPromise({
      try: () => storeTables(config.storePath),
      catch: (cause) => new Error(`the gateway cannot read its store: ${String(cause)}`),
    })
    const own = new Set([
      gatewayMigrationsTable,
      "capability_grants",
      "capability_bindings",
      "capability_tokens",
      "capability_proofs",
    ])
    if (tables?.some((name) => !own.has(name)))
      return yield* Effect.fail(new Error("the gateway's store holds tables of another store"))
    const context = yield* Layer.build(SqliteClient.layer({ filename: config.storePath }))
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`PRAGMA foreign_keys = ON`
      yield* sql`PRAGMA busy_timeout = 5000`
      yield* runGatewayMigrations
      const gateway = yield* makeCapabilityGateway(
        config,
        options.upstream,
        undefined,
        options.keys,
      )
      yield* serveControl({
        socket: config.controlSocket,
        daemon: config.daemon,
        target: gateway.control,
      })
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => serveCapabilityListener(config.listen, capabilityApi(gateway)),
          catch: (error) =>
            error instanceof Error ? error : new Error("capability listener unavailable"),
        }),
        (close) => Effect.tryPromise(close).pipe(Effect.orDie),
      )
      return { socket: config.listen.socket }
    }).pipe(Effect.provide(context))
  })

/** The login directory that the noscope provider `provider-access` hands custody, if any. */
async function providerAccessDirectory(configHome: string) {
  const text = await readFile(join(configHome, "noscope/providers/provider-access.toml"), "utf8")
  const parsed: unknown = Bun.TOML.parse(text)
  const mint =
    typeof parsed === "object" &&
    parsed !== null &&
    "commands" in parsed &&
    typeof parsed.commands === "object" &&
    parsed.commands !== null &&
    "mint" in parsed.commands &&
    typeof parsed.commands.mint === "string"
      ? parsed.commands.mint.split(" ")
      : []
  const at = mint.indexOf("access")
  return at < 0 ? undefined : mint[at + 1]
}

/** Process entry: serve until stopped, and name the listener's socket on standard output. */
const runCapabilityGatewayServer = (env: Record<string, string | undefined>) =>
  serveCapabilityGateway(env).pipe(
    Effect.tap(({ socket }) => Effect.sync(() => process.stdout.write(`listening ${socket}\n`))),
    Effect.andThen(Effect.never),
    Effect.scoped,
  )

/**
 * `import-login <provider>`: the login of `provider` from standard input into the gateway's
 * custody. It is never an argument, a variable of the environment or a route. The output names
 * the provider and whether a login was there already, never a value. It reads at most 16385
 * bytes (`loginLimit` and one more), so a longer login is refused without reading the rest.
 */
export async function importLoginCommand(
  env: Record<string, string | undefined>,
  args: ReadonlyArray<string>,
  read: (limit: number) => Promise<Buffer>,
) {
  try {
    const [name, ...extra] = args
    if (name === undefined) throw new ImportRefused("name one provider")
    const provider = custodyProvider(name)
    if (!provider) throw new ImportRefused(`no provider ${name}`)
    if (extra.length > 0) throw new ImportRefused("the login is read from standard input only")
    const config = loadCapabilityGatewayConfig(env)
    if (!config.login) throw new ImportRefused("the gateway's configuration names no login")
    // One byte past the limit shows a longer login; nothing past it is read.
    const { outcome, owner } = await importLogin(
      config.login.directory,
      provider,
      await read(loginLimit + 1),
    )
    return { code: 0, output: `${outcome} the ${provider} login, owned by uid ${owner}\n` }
  } catch (error) {
    const reason =
      error instanceof ImportRefused || error instanceof CustodyRefused
        ? error.message
        : "the login was not stored"
    return { code: 1, error: `import-login refused: ${reason}\n` }
  }
}

/** Standard input to its end or to `limit` bytes, whichever comes first. */
function readStandardInput(limit: number) {
  const buffer = Buffer.alloc(limit)
  let size = 0
  while (size < limit) {
    const read = readSync(0, buffer, size, limit - size, null)
    if (read === 0) break
    size += read
  }
  return buffer.subarray(0, size)
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2)
  if (command === "import-login") {
    // import-login holds the login in memory: before it reads it, it writes no core file.
    let forbidden = true
    try {
      forbidCoreFiles()
    } catch {
      forbidden = false
    }
    const result = forbidden
      ? await importLoginCommand(process.env, args, (limit) =>
          Promise.resolve(readStandardInput(limit)),
        )
      : { code: 1, output: "", error: "import-login refused: the core file limit was not set\n" }
    if (result.output) process.stdout.write(result.output)
    if (result.error) process.stderr.write(result.error)
    process.exitCode = result.code
  } else BunRuntime.runMain(runCapabilityGatewayServer(process.env))
}
