import { Schema } from "effect"
import { isAbsolute } from "node:path"
import { WorkerPolicy } from "./broker"
const Policies = Schema.Array(
  Schema.Struct({ name: Schema.NonEmptyString, ...WorkerPolicy.fields }),
).check(Schema.isMinLength(1))
export type WorkerIdentityConfig = {
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
  return { directory, socket, policies }
}
