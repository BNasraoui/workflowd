import { Octokit } from "@octokit/rest"
import { Effect } from "effect"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeSandboxGithub } from "../../src/sandbox/github"

export type GithubApiRequest = {
  readonly method: string
  readonly path: string
  readonly authorization: string | null
  readonly body: unknown
}

/**
 * A GitHub API stub on the loopback address, with a GitHub App of a generated key.
 * It mints installation tokens and revokes them; `route` answers every other
 * request, else 404. It records each request. Nothing reaches GitHub.
 */
export async function githubApiStub(
  route: (path: string) => Response | undefined = () => undefined,
  token = "fixture-token",
) {
  const root = await mkdtemp(join(tmpdir(), "github-api-stub-"))
  const privateKeyPath = join(root, "app.pem")
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  })
  await writeFile(privateKeyPath, key, { mode: 0o600 })
  const requests: GithubApiRequest[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const text = await request.text()
      requests.push({
        method: request.method,
        path,
        authorization: request.headers.get("authorization"),
        body: text === "" ? undefined : JSON.parse(text),
      })
      if (request.method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(path))
        return Response.json({ token }, { status: 201 })
      if (request.method === "DELETE" && path === "/installation/token")
        return new Response(null, { status: 204 })
      return route(path) ?? new Response(null, { status: 404 })
    },
  })
  const github = await Effect.runPromise(
    makeSandboxGithub(
      { appId: 1, privateKeyPath },
      Octokit.defaults({ baseUrl: server.url.toString().replace(/\/$/, "") }),
    ),
  )
  return {
    github,
    requests,
    /** The requests that mint a token, by their body, and those that revoke one. */
    minted: () =>
      requests
        .filter((request) => request.path.endsWith("/access_tokens"))
        .map((request) => request.body),
    revoked: () =>
      requests.filter(
        (request) => request.method === "DELETE" && request.path === "/installation/token",
      ),
    close: async () => {
      await server.stop(true)
      await rm(root, { recursive: true, force: true })
    },
  }
}
