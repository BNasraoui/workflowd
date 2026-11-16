/**
 * The limits that the runner's relay and helper share with the gateway. The gateway's config
 * decodes `maxStreamsPerRun` up to `maxStreamsPerRun` here, and the relay admits no more than
 * that many streams at once.
 */
export const maxStreamsPerRun = 4
/**
 * The most connections that a run's relay holds to the gateway at once. Once the run's session is
 * open, the relay is its runner's one client of the gateway: each model call, Git read, renewal
 * and run route request of the run goes through it.
 */
export const maxRelaySockets = 8
/**
 * The form of a provider id. The gateway's config holds it, the session grant names it, and the
 * relay puts it in the path of each model call.
 */
export const providerIdPattern = /^[a-z][a-z0-9-]{0,63}$/
/** The longest OIDC proof that the helper sends and that the gateway reads. */
export const maxProofLength = 16384
/** The longest jti of a proof that opens a session. */
export const maxJtiLength = 256
/**
 * The most bytes of a model call's body. The gateway reads no more of a model call, and the relay
 * holds the body of each, so that it can send a call once again (capability-relay.mjs).
 */
export const maxModelBodyBytes = 1048576
/** The bytes of all request header names and values, and of one header value. */
export const maxHeaderBytes = 8192
export const maxHeaderValueBytes = 2048
/**
 * The longest time in milliseconds that a model stream may go without a chunk. The gateway's
 * config decodes `streamIdleMs` up to this value, and its listener destroys a socket idle for
 * this long, so a larger idle limit could never take effect.
 */
export const maxStreamIdleMs = 120000
/**
 * The run routes of a runner run. A batch of event lines is at most `maxEventBatchBytes` as the
 * runner posts it. A result is one body: the 4-byte big-endian length of result.json, result.json
 * of at most `maxResultManifestBytes`, and result.bundle of at most `maxResultBundleBytes`. The
 * gateway reads at most `maxRunUploads` results at once.
 */
export const maxEventBatchBytes = 64 * 1024
export const maxResultManifestBytes = 256 * 1024
export const maxResultBundleBytes = 16 * 1024 * 1024
export const maxResultBody = 4 + maxResultManifestBytes + maxResultBundleBytes
export const maxRunUploads = 4
