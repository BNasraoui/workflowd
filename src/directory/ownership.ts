import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { DirectoryError, type ExternalRegistration } from "./contract"
import { externalRecipientId } from "./proof"
import { canonicalJson } from "../kernel/session-store-support"

/** Called inside the accepting observation/registration transaction. Owner fences
 * outlive endpoint leases and host observations, including a host transfer. */
export const claimExternalOwner = Effect.fn("Directory.claimExternalOwner")(function* (
  sql: SqlClient.SqlClient,
  registration: ExternalRegistration,
) {
  const recipientId = externalRecipientId(registration.publicKey)
  const bindings =
    yield* sql`SELECT revision,registration_json FROM directory_owner_bindings WHERE recipient_id = ${recipientId}`
  const binding = bindings[0]
  if (
    binding !== undefined &&
    typeof binding.revision === "number" &&
    binding.revision > registration.revision
  )
    return false
  if (
    binding !== undefined &&
    binding.revision === registration.revision &&
    binding.registration_json !== canonicalJson(registration)
  )
    return yield* Effect.fail(new DirectoryError({ reason: "stale_binding" }))
  yield* sql`INSERT INTO directory_owner_bindings(recipient_id,host_id,revision,registration_json) VALUES(${recipientId},${registration.hostId},${registration.revision},${canonicalJson(registration)})
    ON CONFLICT(recipient_id) DO UPDATE SET host_id = excluded.host_id, revision = excluded.revision, registration_json = excluded.registration_json`
  return true
})
