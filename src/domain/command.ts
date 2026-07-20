import { Schema } from "effect"
import { PullRequestNumber } from "./identifiers"
import { RepositoryRef } from "./pull-request-transition"

const exact = { parseOptions: { onExcessProperty: "error" as const } }
const PositiveInt = Schema.Int.pipe(Schema.positive())

export const Command = Schema.TaggedStruct("Command", {
  action: Schema.NonEmptyString,
  command: Schema.Literal("fix", "review", "status"),
  commentId: PositiveInt,
  commenter: Schema.NonEmptyString,
  installationId: PositiveInt,
  pullRequestNumber: PullRequestNumber,
  repository: RepositoryRef,
}).annotations(exact)

export type Command = typeof Command.Type
