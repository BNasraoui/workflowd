import { Schema } from "effect"
import { isAbsolute } from "node:path"
import { WorkerPolicy } from "./broker"
const Policies = Schema.Array(
  Schema.Struct({ name: Schema.NonEmptyString, ...WorkerPolicy.fields }),
).check(Schema.isMinLength(1))
export type WorkerIdentityConfig = {
  readonly secret: string
  readonly directory: string
  readonly endpoint: string
  readonly policies: typeof Policies.Type
}
export async function loadWorkerIdentityConfig(
  env: Record<string, string | undefined>,
  read: (path: string) => Promise<string>,
): Promise<WorkerIdentityConfig | undefined> {
  if (
    env.WORKFLOWD_WORKER_GITHUB_ENABLED === undefined ||
    env.WORKFLOWD_WORKER_GITHUB_ENABLED === "false"
  )
    return undefined
  if (env.WORKFLOWD_WORKER_GITHUB_ENABLED !== "true")
    throw new Error("WORKFLOWD_WORKER_GITHUB_ENABLED must be true or false")
  const secret =
    env.WORKFLOWD_WORKER_GITHUB_SECRET_FILE === undefined
      ? ""
      : (await read(env.WORKFLOWD_WORKER_GITHUB_SECRET_FILE)).trim()
  if (secret.length < 32)
    throw new Error("WORKFLOWD_WORKER_GITHUB_SECRET_FILE must contain at least 32 characters")
  const directory = env.WORKFLOWD_WORKER_GITHUB_DIRECTORY ?? ""
  if (!isAbsolute(directory)) throw new Error("WORKFLOWD_WORKER_GITHUB_DIRECTORY must be absolute")
  const endpoint = env.WORKFLOWD_WORKER_GITHUB_ENDPOINT ?? "http://127.0.0.1:8787"
  const url = new URL(endpoint)
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
  )
    throw new Error("Worker identity requires HTTPS or loopback")
  const policies = Schema.decodeUnknownSync(Policies)(
    JSON.parse(env.WORKFLOWD_WORKER_GITHUB_REPOSITORIES ?? "null"),
  )
  if (
    new Set(policies.map((p) => p.name)).size !== policies.length ||
    policies.some((p) => Object.keys(p.permissions).length === 0)
  )
    throw new Error("Worker identities need unique names and explicit permissions")
  return { secret, directory, endpoint, policies }
}
