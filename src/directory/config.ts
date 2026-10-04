import { readFile } from "node:fs/promises"
import { Redacted, Schema } from "effect"
import { RemoteHostId } from "../remote/contract"
import { loadRemoteNatsAuth, type RemoteNatsAuth } from "../remote/auth"
import { parseNatsServers } from "../remote/nats-url"

export type DirectoryPeer = {
  readonly hostId: string
  readonly credential: Redacted.Redacted<string>
}
export type DirectoryRemoteConfig = {
  readonly peers: ReadonlyArray<DirectoryPeer>
  readonly servers: ReadonlyArray<string>
  readonly auth: RemoteNatsAuth
  readonly refreshMs: number
  readonly leaseMs: number
}
const credential = async (path: string, read: (path: string) => Promise<string>) => {
  let value: string
  try {
    value = (await read(path)).trim()
  } catch {
    throw new Error("Could not read directory host credential")
  }
  if (Buffer.byteLength(value) < 32 || Buffer.byteLength(value) > 4096)
    throw new Error("Directory host credentials must contain 32–4096 bytes")
  return Redacted.make(value)
}

export async function loadDirectoryRemoteConfig(
  env: Record<string, string | undefined>,
  hostId: string,
  read: (path: string) => Promise<string>,
): Promise<DirectoryRemoteConfig | undefined> {
  if (env.WORKFLOWD_DIRECTORY_PEERS === undefined) return undefined
  const peers = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Record(RemoteHostId, Schema.NonEmptyString)),
  )(env.WORKFLOWD_DIRECTORY_PEERS)
  if (Object.keys(peers).length > 64 || Object.keys(peers).length === 0 || hostId in peers)
    throw new Error("Directory peers must name 1–64 other hosts")
  const refreshMs = Number(env.WORKFLOWD_DIRECTORY_REFRESH_MS ?? 30_000)
  const leaseMs = Number(env.WORKFLOWD_DIRECTORY_LEASE_MS ?? 90_000)
  if (
    !Number.isSafeInteger(refreshMs) ||
    refreshMs < 10 ||
    refreshMs > 30_000 ||
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < 100 ||
    leaseMs > 300_000 ||
    refreshMs >= leaseMs
  )
    throw new Error("Invalid directory refresh/lease interval")
  if (env.WORKFLOWD_NATS_SERVERS === undefined)
    throw new Error("Directory peers require WORKFLOWD_NATS_SERVERS")
  const enrolled = await Promise.all(
    Object.entries(peers).map(async ([hostId, path]) => ({
      hostId,
      credential: await credential(path, read),
    })),
  )
  if (new Set(enrolled.map((peer) => Redacted.value(peer.credential))).size !== enrolled.length)
    throw new Error("Directory host credentials must be distinct")
  return {
    peers: enrolled,
    servers: parseNatsServers(env.WORKFLOWD_NATS_SERVERS),
    auth: await loadRemoteNatsAuth(env, read),
    refreshMs,
    leaseMs,
  }
}

export type DirectoryRunnerConfig = {
  readonly coordinatorHostId: string
  readonly credential: Redacted.Redacted<string>
  readonly codexEnabled: boolean
  readonly codexBinary: string
  readonly openCode?: {
    readonly baseUrl: string
    readonly serverId: string
    readonly username: string
    readonly password: Redacted.Redacted<string>
  }
}
export async function loadDirectoryRunnerConfig(
  env: Record<string, string | undefined>,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<DirectoryRunnerConfig | undefined> {
  const path = env.WORKFLOWD_DIRECTORY_CREDENTIAL_FILE
  const host = env.WORKFLOWD_DIRECTORY_COORDINATOR_HOST
  if (path === undefined && host === undefined) return undefined
  if (path === undefined || host === undefined)
    throw new Error("Directory runner requires credential file and coordinator host")
  const enabled = env.WORKFLOWD_EXECUTION_CAPABILITIES_CODEX_ENABLED ?? "true"
  if (enabled !== "true" && enabled !== "false")
    throw new Error("Invalid runner Codex discovery setting")
  let openCode: DirectoryRunnerConfig["openCode"]
  if (env.OPENCODE_SERVER_URL !== undefined) {
    let url: URL
    try {
      url = new URL(env.OPENCODE_SERVER_URL)
    } catch {
      throw new Error("Invalid runner OpenCode URL")
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    )
      throw new Error("Invalid runner OpenCode URL")
    if (
      env.OPENCODE_SERVER_PASSWORD !== undefined &&
      env.OPENCODE_SERVER_PASSWORD_FILE !== undefined
    )
      throw new Error("Set one runner OpenCode password source")
    let password: string | undefined
    try {
      password =
        env.OPENCODE_SERVER_PASSWORD_FILE === undefined
          ? env.OPENCODE_SERVER_PASSWORD
          : (await read(env.OPENCODE_SERVER_PASSWORD_FILE)).replace(/\r?\n$/, "")
    } catch {
      throw new Error("Could not read runner OpenCode password")
    }
    if (password === undefined || password === "")
      throw new Error("Runner OpenCode discovery requires its server password")
    openCode = {
      baseUrl: url.toString(),
      serverId: Schema.decodeUnknownSync(RemoteHostId)(
        env.WORKFLOWD_OPENCODE_SERVER_ID ?? "opencode-primary",
      ),
      username: env.OPENCODE_SERVER_USERNAME ?? "opencode",
      password: Redacted.make(password),
    }
  }
  return {
    coordinatorHostId: Schema.decodeUnknownSync(RemoteHostId)(host),
    credential: await credential(path, read),
    codexEnabled: enabled === "true",
    codexBinary: env.WORKFLOWD_AGENT_RUN_CODEX_BIN ?? "codex",
    ...(openCode === undefined ? {} : { openCode }),
  }
}
