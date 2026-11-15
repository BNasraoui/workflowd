/**
 * The limits that the runner's relay and helper share with the gateway. The gateway's config
 * decodes `maxStreamsPerRun` up to `maxStreamsPerRun` here, and the relay admits no more than
 * that many streams at once.
 */
export const maxStreamsPerRun = 4
/** The longest OIDC proof that the helper sends and that the gateway reads. */
export const maxProofLength = 16384
/** The longest jti of a proof that opens a session. */
export const maxJtiLength = 256
/** The bytes of all request header names and values, and of one header value. */
export const maxHeaderBytes = 8192
export const maxHeaderValueBytes = 2048
