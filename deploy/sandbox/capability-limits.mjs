/**
 * The limits that the runner's relay and helper share with the gateway. The gateway's config
 * decodes `maxStreamsPerRun` up to `maxStreamsPerRun` here, and the relay admits no more than
 * that many streams at once.
 */
export const maxStreamsPerRun = 4
/**
 * The form of a provider id. The gateway's config holds it, the session grant names it, and the
 * relay puts it in the path of each model call.
 */
export const providerIdPattern = /^[a-z][a-z0-9-]{0,63}$/
/** The longest OIDC proof that the helper sends and that the gateway reads. */
export const maxProofLength = 16384
/** The longest jti of a proof that opens a session. */
export const maxJtiLength = 256
/** The bytes of all request header names and values, and of one header value. */
export const maxHeaderBytes = 8192
export const maxHeaderValueBytes = 2048
/**
 * The longest time in milliseconds that a model stream may go without a chunk. The gateway's
 * config decodes `streamIdleMs` up to this value, and its listener destroys a socket idle for
 * this long, so a larger idle limit could never take effect.
 */
export const maxStreamIdleMs = 120000
