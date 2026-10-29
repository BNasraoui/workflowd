import { Schema } from "effect"
import { CiTarget } from "./ci/event"

const Repositories = Schema.Array(
  Schema.Struct({
    repository: CiTarget.fields.repository,
    installationId: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
).check(Schema.isMinLength(1))

export type PrRepositories = typeof Repositories.Type

export function loadPrRepositories(value: string | undefined): PrRepositories {
  let repositories: PrRepositories
  try {
    repositories = Schema.decodeUnknownSync(Repositories)(JSON.parse(value ?? "null"))
  } catch (cause) {
    throw new Error(
      "WORKFLOWD_PR_REPOSITORIES must be a non-empty JSON array of repository/installationId entries",
      { cause },
    )
  }
  if (new Set(repositories.map((r) => r.repository.toLowerCase())).size !== repositories.length)
    throw new Error("WORKFLOWD_PR_REPOSITORIES contains a duplicate repository")
  return repositories.map((r) => ({ ...r, repository: r.repository.toLowerCase() }))
}
