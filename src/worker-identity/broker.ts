import { Cache, Effect, Exit, Redacted, Schema } from "effect"
export const WorkerPolicy = Schema.Struct({
  repository: Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/)),
  installationId: Schema.Int.check(Schema.isGreaterThan(0)),
  permissions: Schema.Struct({
    actions: Schema.optionalKey(Schema.Literal("read")),
    checks: Schema.optionalKey(Schema.Literal("read")),
    contents: Schema.optionalKey(Schema.Literals(["read", "write"])),
    pull_requests: Schema.optionalKey(Schema.Literals(["read", "write"])),
    issues: Schema.optionalKey(Schema.Literals(["read", "write"])),
  }),
})
export type WorkerPolicy = typeof WorkerPolicy.Type
const Token = Schema.Struct({ token: Schema.NonEmptyString, expires_at: Schema.String })
type MintInput = {
  readonly installation_id: number
  readonly repositories: string[]
  readonly permissions: WorkerPolicy["permissions"]
}

export const makeTokenBroker = (mint: (input: MintInput) => Promise<unknown>) =>
  Effect.gen(function* () {
    const cache = yield* Cache.makeWith(
      (key: string) =>
        Effect.gen(function* () {
          const policy = yield* Effect.try((): unknown => JSON.parse(key)).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(WorkerPolicy)),
          )
          const result = yield* Effect.tryPromise({
            try: () =>
              mint({
                installation_id: policy.installationId,
                repositories: [policy.repository.split("/")[1]!],
                permissions: policy.permissions,
              }),
            catch: () =>
              new Error("Installation token unavailable; verify App installation permissions"),
          })
          const token = yield* Schema.decodeUnknownEffect(Token)(result).pipe(
            Effect.mapError(() => new Error("Invalid installation token response")),
          )
          const expiresAt = Date.parse(token.expires_at)
          if (!Number.isFinite(expiresAt) || expiresAt < Date.now() + 300000)
            return yield* Effect.fail(new Error("Installation token expires too soon"))
          return { token: Redacted.make(token.token), expiresAt }
        }),
      {
        capacity: 100,
        timeToLive: (exit) =>
          Exit.isSuccess(exit) ? Math.max(0, exit.value.expiresAt - Date.now() - 300000) : 0,
      },
    )
    return (policy: WorkerPolicy) => Cache.get(cache, JSON.stringify(policy))
  })
