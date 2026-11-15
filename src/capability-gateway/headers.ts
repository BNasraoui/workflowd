import { maxHeaderBytes, maxHeaderValueBytes } from "../../deploy/sandbox/capability-limits.mjs"

/** The origin of every request that the relay sends on to the gateway. */
export const capabilityOrigin = "http://capability.invalid"

/** A request that the gateway refuses with 403; any other failure of a route is a 503. */
export class RequestRefused extends Error {
  readonly _tag = "RequestRefused"
  constructor() {
    super("request refused")
  }
}

/**
 * Checks each header of a request: in all at most `maxHeaderBytes` of names and values, each value
 * at most `maxHeaderValueBytes` with no CR, LF or NUL, and each one `allowed`.
 */
export function checkHeaders(request: Request, allowed: (name: string, value: string) => boolean) {
  let bytes = 0
  for (const [name, value] of request.headers) {
    bytes += name.length + value.length
    if (
      bytes > maxHeaderBytes ||
      value.length > maxHeaderValueBytes ||
      /[\r\n\0]/.test(value) ||
      !allowed(name, value)
    )
      throw new RequestRefused()
  }
}
