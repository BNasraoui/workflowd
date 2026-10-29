import { Schema } from "effect"
import { ExecutionCapabilities } from "../execution-capability-contract"
import { RemoteHostId } from "../remote/contract"

const Identifier = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(256)))
export const DirectoryEndpoint = Schema.Struct({
  harness: Schema.Literals(["opencode", "codex", "claude"]),
  transport: Schema.Literals(["opencode-http", "codex-app-server", "cli-session", "relay-http"]),
  address: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(2048))),
  nativeSessionId: Identifier,
})
export type DirectoryEndpoint = typeof DirectoryEndpoint.Type

export const ExternalRegistration = Schema.Struct({
  protocol: Schema.Literal("workflowd-directory-register-v1"),
  hostId: RemoteHostId,
  publicKey: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(128))),
  revision: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  ),
  endpoint: DirectoryEndpoint.pipe(
    Schema.check(
      Schema.makeFilter((endpoint) => {
        if (endpoint.transport !== "relay-http") return false
        try {
          const url = new URL(endpoint.address)
          return (
            url.protocol === "http:" &&
            url.hostname === "127.0.0.1" &&
            url.port !== "" &&
            url.username === "" &&
            url.password === "" &&
            url.hash === "" &&
            url.search === "" &&
            url.toString() === endpoint.address
          )
        } catch {
          return false
        }
      }),
    ),
  ),
  signature: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(256))),
})
export type ExternalRegistration = typeof ExternalRegistration.Type

export const RegistrationReceipt = Schema.Struct({
  recipientId: Identifier,
  status: Schema.Literals(["registered", "duplicate"]),
})
export type RegistrationReceipt = typeof RegistrationReceipt.Type

export const AgentRecipient = Schema.Struct({
  recipientId: Identifier,
  hostId: RemoteHostId,
  runnerId: Identifier,
  origin: Schema.Literals(["managed", "external"]),
  runId: Schema.NullOr(Identifier),
  status: Schema.Literals(["accepted", "launching", "active", "expired", "unavailable"]),
  endpoint: Schema.NullOr(DirectoryEndpoint),
  bindingVersion: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  observedAt: Schema.String,
  expiresAt: Schema.String,
  deliverable: Schema.Boolean,
})
export type AgentRecipient = typeof AgentRecipient.Type

export const DirectoryRunner = Schema.Struct({
  runnerId: Identifier,
  hostId: RemoteHostId,
  status: Schema.Literals(["active", "expired", "unavailable"]),
  observedAt: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.String),
  catalog: ExecutionCapabilities,
})
export type DirectoryRunner = typeof DirectoryRunner.Type

export const DirectorySnapshot = Schema.Struct({
  agents: Schema.Array(AgentRecipient),
  runners: Schema.Array(DirectoryRunner),
})
export type DirectorySnapshot = typeof DirectorySnapshot.Type

export class DirectoryError extends Schema.TaggedError<DirectoryError>()("DirectoryError", {
  reason: Schema.Literals([
    "ownership_conflict",
    "stale_binding",
    "endpoint_unverified",
    "unavailable",
    "invalid_observation",
  ]),
}) {}

export const runnerIdForHost = (hostId: string) => `runner:${hostId}`
