import { loadRunSocketPolicy, type RunSocketPolicy } from "./peer"
import { Schema } from "effect"
import { isAbsolute } from "node:path"
import { WorkerPolicy } from "./broker"
const Policies = Schema.Array(
  Schema.Struct({ name: Schema.NonEmptyString, ...WorkerPolicy.fields }),
).check(Schema.isMinLength(1))
export type WorkerIdentityConfig = {
  readonly peer?: RunSocketPolicy | undefined
  readonly home?: string
  readonly command?: string
  readonly directory: string
  readonly socket: string
  readonly policies: typeof Policies.Type
}
export function loadWorkerIdentityConfig(
  env: Record<string, string | undefined>,
): WorkerIdentityConfig | undefined {
  if (
    env.WORKFLOWD_WORKER_GITHUB_ENABLED === undefined ||
    env.WORKFLOWD_WORKER_GITHUB_ENABLED === "false"
  )
    return undefined
  if (env.WORKFLOWD_WORKER_GITHUB_ENABLED !== "true")
    throw new Error("WORKFLOWD_WORKER_GITHUB_ENABLED must be true or false")
  const directory = env.WORKFLOWD_WORKER_GITHUB_DIRECTORY ?? ""
  if (!isAbsolute(directory)) throw new Error("WORKFLOWD_WORKER_GITHUB_DIRECTORY must be absolute")
  const socket = env.WORKFLOWD_WORKER_GITHUB_SOCKET ?? ""
  if (!isAbsolute(socket)) throw new Error("WORKFLOWD_WORKER_GITHUB_SOCKET must be absolute")
  const policies = Schema.decodeUnknownSync(Policies)(
    JSON.parse(env.WORKFLOWD_WORKER_GITHUB_REPOSITORIES ?? "null"),
  )
  if (
    new Set(policies.map((p) => p.name)).size !== policies.length ||
    policies.some((p) => Object.keys(p.permissions).length === 0)
  )
    throw new Error("Worker identities need unique names and explicit permissions")
  const command = env.WORKFLOWD_WORKER_GITHUB_COMMAND
  if (command !== undefined && !isAbsolute(command))
    throw new Error("WORKFLOWD_WORKER_GITHUB_COMMAND must be absolute")
  const home = env.WORKFLOWD_AGENT_HOME
  if (env.WORKFLOWD_AGENT_HOST_SOCKET && (!home || !command || !loadRunSocketPolicy(env)))
    throw new Error("Agent host requires its home, installed broker command, UID and GID")
  if (home !== undefined && !isAbsolute(home))
    throw new Error("WORKFLOWD_AGENT_HOME must be absolute")
  return {
    directory,
    socket,
    policies,
    ...(home ? { home } : {}),
    peer: loadRunSocketPolicy(env),
    ...(command === undefined ? {} : { command }),
  }
}
