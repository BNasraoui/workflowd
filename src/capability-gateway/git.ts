import { readRequestBody, safeProviderResponse } from "./claude"

export interface GitRequest {
  readonly method: "GET" | "POST"
  readonly body?: Uint8Array<ArrayBuffer>
  readonly headers: Headers
  readonly signal: AbortSignal
  readonly redirect: "error"
}
export type GitUpstream = (url: string, input: GitRequest) => Promise<Response>

function validateGitHeaders(request: Request, upload: boolean, advertisement: boolean) {
  let bytes = 0
  for (const [name, value] of request.headers) {
    bytes += name.length + value.length
    if (
      bytes > 8192 ||
      value.length > 2048 ||
      /[\r\n\0]/.test(value) ||
      ![
        "authorization",
        "host",
        "content-type",
        "content-length",
        "accept",
        "accept-encoding",
        "accept-language",
        "pragma",
        "user-agent",
        "git-protocol",
      ].includes(name)
    )
      throw new Error("request refused")
  }
  const protocol = request.headers.get("git-protocol")
  if (
    (request.headers.get("host") ?? "capability.invalid") !== "capability.invalid" ||
    (protocol !== null && !/^version=[012]$/.test(protocol)) ||
    (upload && request.headers.get("content-type") !== "application/x-git-upload-pack-request") ||
    (advertisement &&
      (request.body !== null || Number(request.headers.get("content-length") ?? 0) !== 0))
  )
    throw new Error("request refused")
  return protocol
}

/** The saved repository selects the destination; the caller can select only upload-pack. */
export async function gitReadRequest(
  request: Request,
  path: string,
  repository: { readonly repositoryId: number; readonly repositoryName: string },
  credential: () => Promise<string | undefined>,
  signal: AbortSignal,
  send: GitUpstream,
) {
  const prefix = `/capabilities/v1/git/${repository.repositoryId}.git`
  const advertisement =
    request.method === "GET" && path === `${prefix}/info/refs?service=git-upload-pack`
  const upload = request.method === "POST" && path === `${prefix}/git-upload-pack`
  if (
    (!advertisement && !upload) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.repositoryName)
  )
    throw new Error("request refused")
  const protocol = validateGitHeaders(request, upload, advertisement)
  const body = upload ? await readRequestBody(request, signal, 1048576) : undefined
  const access = await credential()
  const headers = new Headers({ "accept-encoding": "identity" })
  if (protocol) headers.set("git-protocol", protocol)
  if (upload) headers.set("content-type", "application/x-git-upload-pack-request")
  const basic = access ? Buffer.from(`x-access-token:${access}`).toString("base64") : undefined
  if (basic) headers.set("authorization", `Basic ${basic}`)
  signal.throwIfAborted()
  const response = await send(
    `https://github.com/${repository.repositoryName}.git${path.slice(prefix.length)}`,
    {
      method: upload ? "POST" : "GET",
      ...(body === undefined ? {} : { body }),
      headers,
      signal,
      redirect: "error",
    },
  )
  const contentType = `application/x-git-upload-pack-${advertisement ? "advertisement" : "result"}`
  if (
    response.status !== 200 ||
    response.headers.get("content-type") !== contentType ||
    response.headers.has("content-encoding")
  ) {
    await response.body?.cancel()
    throw new Error("upstream unavailable")
  }
  return {
    response:
      access && basic ? (await safeProviderResponse(response, [access, basic])).response : response,
    headers: new Headers({ "content-type": contentType, "cache-control": "no-store" }),
    selectionObserved: false,
  }
}
