/**
 * Answers `request` with `git http-backend` over the repositories under `root`. A backend that
 * fails or writes to its standard error gives 500 with that text.
 */
export async function gitHttpBackend(root: string, request: Request) {
  const url = new URL(request.url)
  const child = Bun.spawn(["git", "http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers.get("content-type") ?? "",
      GIT_PROTOCOL: request.headers.get("git-protocol") ?? "",
    },
    stdin: request.method === "POST" ? new Blob([await request.arrayBuffer()]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [bytes, errors, exit] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const output = Buffer.from(bytes),
    split = output.indexOf("\r\n\r\n")
  if (exit !== 0 || errors !== "" || split <= 0) return new Response(errors, { status: 500 })
  const headers = new Headers()
  for (const line of output.subarray(0, split).toString().split("\r\n")) {
    const colon = line.indexOf(":")
    headers.set(line.slice(0, colon), line.slice(colon + 1).trim())
  }
  return new Response(output.subarray(split + 4), { headers })
}
