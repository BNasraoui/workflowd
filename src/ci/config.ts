import { Schema } from "effect"
import { CiTarget } from "./event"
import { loadRemoteNatsAuth, type RemoteNatsAuth } from "../remote/auth"
import { parseNatsServers } from "../remote/nats-url"
const Repositories = Schema.Array(
  Schema.Struct({
    repository: CiTarget.fields.repository,
    dispatchRepository: Schema.optionalKey(Schema.NonEmptyString),
    installationId: Schema.Int.check(Schema.isGreaterThan(0)),
    workflows: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)),
  }),
).check(Schema.isMinLength(1))
export type CiConfig = {
  readonly token: string
  readonly repositories: typeof Repositories.Type
  readonly servers: ReadonlyArray<string>
  readonly auth: RemoteNatsAuth
}
export async function loadCiConfig(
  env: Record<string, string | undefined>,
  read: (path: string) => Promise<string>,
): Promise<CiConfig | undefined> {
  if (env.WORKFLOWD_CI_ENABLED === undefined || env.WORKFLOWD_CI_ENABLED === "false")
    return undefined
  if (env.WORKFLOWD_CI_ENABLED !== "true")
    throw new Error("WORKFLOWD_CI_ENABLED must be true or false")
  const token =
    env.WORKFLOWD_CI_TOKEN_FILE === undefined
      ? env.WORKFLOWD_CI_TOKEN
      : (await read(env.WORKFLOWD_CI_TOKEN_FILE)).trim()
  if (token === undefined || token.length < 8)
    throw new Error("WORKFLOWD_CI_TOKEN(_FILE) must contain at least 8 characters")
  const repositories = Schema.decodeUnknownSync(Repositories)(
    JSON.parse(env.WORKFLOWD_CI_REPOSITORIES ?? "null"),
  )
  if (new Set(repositories.map((r) => r.repository.toLowerCase())).size !== repositories.length)
    throw new Error("duplicate CI repository")
  return {
    token,
    repositories: repositories.map((r) => ({ ...r, repository: r.repository.toLowerCase() })),
    servers: parseNatsServers(env.WORKFLOWD_NATS_SERVERS ?? ""),
    auth: await loadRemoteNatsAuth(env, read),
  }
}
