import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Octokit } from "@octokit/rest"
export async function githubFixture() {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-app-fixture-"))
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  })
  const privateKeyPath = join(directory, "key.pem")
  await writeFile(privateKeyPath, key, { mode: 0o600 })
  const bodies: unknown[] = []
  let status = 200
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "POST") {
        const text = await request.text()
        bodies.push(text === "" ? {} : JSON.parse(text))
        return Response.json(
          {
            token: "test-installation-token",
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          },
          { status: 201 },
        )
      }
      return status === 304
        ? new Response(null, { status })
        : Response.json(
            { workflow_runs: [], total_count: 0 },
            { status, headers: { etag: "test-etag" } },
          )
    },
  })
  return {
    directory,
    github: { appId: 1, privateKeyPath, webhookSecret: "unused", prRepositories: [] },
    OctokitClass: Octokit.defaults({
      baseUrl: server.url.toString(),
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    }),
    bodies,
    setStatus: (next: number) => {
      status = next
    },
    close: async () => {
      await server.stop(true)
      await rm(directory, { recursive: true, force: true })
    },
  }
}
