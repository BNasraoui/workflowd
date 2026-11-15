import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { claudeBetas } from "../../src/capability-gateway/claude"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { client, processGateway, proof, sse, withGateway } from "./gateway-process"

/** The one Claude Code version of the repository, which CI installs. */
const pinned = `${readFileSync("test/resources/claude-code-version", "utf8").trim()} (Claude Code)`
const claude = fixtureExecutable("claude")

/** A request that the pinned client sent: its anthropic-beta values and its body text. */
interface Sent {
  readonly betas: ReadonlyArray<string>
  readonly body: string
}

/**
 * Runs the pinned client once, in print mode, against `baseUrl` with `token` as its OAuth token.
 * `forward` answers each request it sends; the run has its own home and no other network use.
 */
async function runPinned(
  model: string,
  token: string,
  forward: (request: Request, body: string) => Promise<Response>,
) {
  const home = await mkdtemp(join(tmpdir(), "wfd-pinned-claude-"))
  const sent: Sent[] = []
  const recorder = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.text()
      sent.push({
        betas: (request.headers.get("anthropic-beta") ?? "").split(",").map((v) => v.trim()),
        body,
      })
      return forward(request, body)
    },
  })
  try {
    const child = Bun.spawn([claude, "-p", "say ok", "--model", model], {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        ANTHROPIC_BASE_URL: recorder.url.origin,
        CLAUDE_CODE_OAUTH_TOKEN: token,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60000,
    })
    const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()])
    return { code, output, sent }
  } finally {
    await recorder.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}

test("the pinned Claude Code is the one CI installs", async () => {
  const version = Bun.spawn([claude, "--version"], { stdout: "pipe", stderr: "ignore" })
  expect((await new Response(version.stdout).text()).trim()).toBe(pinned)
})

// One model of each family the pinned client tells apart: each family adds anthropic-beta values.
for (const model of [
  "claude-opus-5-5",
  "claude-haiku-5-5",
  "claude-sonnet-4-5",
  "claude-opus-4-6[1m]",
])
  test(`the pinned Claude Code sends only anthropic-beta values of the gateway's list (${model})`, async () => {
    const run = await runPinned(
      model,
      "fixture-oauth",
      async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
    )
    expect(run.code).toBe(0)
    expect(run.sent.length).toBeGreaterThan(0)
    const values = [...new Set(run.sent.flatMap((request) => request.betas))].sort()
    // The record of this run: the values that the pinned client sent for this model.
    console.log(`${pinned} ${model} anthropic-beta: ${values.join(",")}`)
    expect(values.filter((value) => !claudeBetas.has(value))).toEqual([])
  }, 90000)

test("the pinned Claude Code completes a call through the gateway process, and its body keeps its meaning", async () => {
  await withGateway(processGateway, async (f, gateway) => {
    const runner = client(gateway.port)
    const { audience } = await runner.audience()
    const { token } = await runner.grant(await runner.session(proof(audience, "jti-pinned")))
    const run = await runPinned("fixture-model", token, (request, body) =>
      fetch(
        runner.url(`/capabilities/v1/providers/anthropic${new URL(request.url).pathname}`) +
          new URL(request.url).search,
        { method: request.method, headers: request.headers, body },
      ),
    )
    expect({ code: run.code, output: run.output.trim() }).toEqual({ code: 0, output: "ok" })
    const received = f.upstreamRequests()
    const parsed = (body: string): unknown => JSON.parse(body)
    expect(received.map((request) => parsed(request.body))).toEqual(
      run.sent.map((request) => parsed(request.body)),
    )
  })
}, 90000)
