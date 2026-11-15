import { Effect, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import type { SavedSandboxPolicy } from "./saved-policy"
import { PublicationReceipt } from "./publish-store"
import { SandboxError } from "./store"

// This names reviewed remote content, not the locally edited candidate action.
export const approvedPublisher = {
  reference:
    "BNasraoui/workflowd/.github/actions/agent-publish@f74e0505155bc32aa2cedef00ba8b08ef1b90007",
  receipt: "legacy" as const,
} as const
/** A trusted constructor dependency for offline fixtures, never repository config. */
export type PublisherContract =
  | typeof approvedPublisher
  | {
      readonly reference: "fixture-only:worktree"
      readonly receipt: "fixed-v1"
    }

export const requireNativePublisherActivation = (
  policy: SavedSandboxPolicy,
  contract: PublisherContract = approvedPublisher,
) =>
  policy.privateBootstrap?.mode === "actions-native" &&
  !(contract.reference === "fixture-only:worktree" && contract.receipt === "fixed-v1")
    ? Effect.fail(
        new SandboxError({
          message:
            "Actions-native activation requires a reviewed publisher pin with the fixed-output protocol",
        }),
      )
    : Effect.void

const fields = {
  stage: PublicationReceipt.fields.stage,
  commitSha: PublicationReceipt.fields.commitSha,
  pr: PublicationReceipt.fields.pr,
  revoked: Schema.Boolean,
  closingIssuesVerified: Schema.Boolean,
  binding: Schema.Json,
  repository: Schema.String,
}
const Legacy = Schema.Struct({
  ...fields,
  branch: Schema.String,
  marker: Schema.String,
  cause: PublicationReceipt.fields.cause,
})
const Fixed = Schema.Struct({ ...fields, v: Schema.Literal(1), failed: Schema.Boolean })

/** The protocol is chosen by trusted tooling custody, never by the receipt itself. */
export const decodePublicationReceipt = Effect.fn("PublisherContract.decode")(function* (
  raw: unknown,
  expected: { binding: string; repository: string; branch: string },
  protocol: "legacy" | "fixed-v1" = approvedPublisher.receipt,
) {
  const proof =
    protocol === "legacy"
      ? yield* Schema.decodeUnknownEffect(Legacy)(raw, { onExcessProperty: "error" })
      : yield* Schema.decodeUnknownEffect(Fixed)(raw, { onExcessProperty: "error" })
  const binding = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
    expected.binding,
  )
  if (
    !isDeepStrictEqual(proof.binding, binding) ||
    proof.repository !== expected.repository ||
    ("branch" in proof &&
      (proof.branch !== expected.branch ||
        proof.marker !==
          `<!-- workflowd-publication:${Buffer.from(expected.binding).toString("base64")} -->`))
  )
    return yield* Effect.fail(new SandboxError({ message: "Publication receipt binding mismatch" }))
  return {
    stage: proof.stage,
    commitSha: proof.commitSha,
    pr: proof.pr,
    revoked: proof.revoked,
    closingIssuesVerified: proof.closingIssuesVerified,
    ...(("failed" in proof ? proof.failed : proof.cause !== undefined)
      ? { cause: "Protected publication failed" }
      : {}),
  }
})
