import { expect, test } from "bun:test"
import { chmod, chown, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createServer } from "node:http"
import { connect } from "node:net"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer, Schema } from "effect"
import { WorkerIdentity, WorkerIdentityLive } from "../../src/worker-identity/service"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { KernelSessionStore, KernelSessionStoreLive } from "../../src/kernel/session-store"
import { WorkflowStoreLive } from "../../src/store"
import { OpenCodeAdapterError } from "../../src/opencode/adapter"
import { codexProjectArguments } from "../../src/execution/project-config"
import { githubFixture } from "../ci/github-fixture"
import { nativeModelFixture } from "../sandbox/native-fixture"

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
async function command(argv: string[], env = process.env, cwd?: string) {
  const child = Bun.spawn(argv, {
    env,
    ...(cwd === undefined ? {} : { cwd }),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`fixture command failed (${argv[0]}): ${error.slice(0, 2000)}`)
  return output.trim()
}

test("installed Codex, Claude and OpenCode push and open PRs with run-bound App identity", async () => {
  const fixture = await githubFixture()
  const root = fixture.directory
  const uid = Number(process.env.WORKFLOWD_AGENT_TEST_AGENT_UID ?? process.getuid!())
  const gid = Number(process.env.WORKFLOWD_AGENT_TEST_AUTH_GID ?? process.getgid!())
  const controllerUid = Number(process.env.WORKFLOWD_AGENT_TEST_BEN_UID ?? process.getuid!())
  const asAgent = (argv: string[]) =>
    uid === process.getuid!()
      ? argv
      : [
          "/usr/bin/setpriv",
          "--reuid",
          String(uid),
          "--regid",
          String(gid),
          "--clear-groups",
          ...argv,
        ]
  await chmod(root, 0o711)
  const bare = join(root, "o/r.git")
  await mkdir(join(root, "o"))
  await command(["git", "init", "--bare", bare])
  await command(["git", "-C", bare, "config", "http.receivepack", "true"])
  const key = join(root, "tls.key"),
    cert = join(root, "tls.crt")
  await command([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    "/CN=github.com",
    "-addext",
    "subjectAltName=DNS:github.com,DNS:api.github.com",
  ])
  await chmod(cert, 0o644)
  const pulls: Array<{ number: number; head: { ref: string; sha: string }; title: string }> = []
  const github = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: Bun.file(key), cert: Bun.file(cert) },
    async fetch(request) {
      const url = new URL(request.url)
      const auth = request.headers.get("authorization") ?? ""
      if (url.pathname.startsWith("/o/r.git/")) {
        if (
          auth !==
          `Basic ${Buffer.from("x-access-token:test-installation-token").toString("base64")}`
        )
          return new Response(null, {
            status: 401,
            headers: { "www-authenticate": 'Basic realm="fixture"' },
          })
        const body = Buffer.from(await request.arrayBuffer())
        const child = Bun.spawn(["git", "http-backend"], {
          env: {
            ...process.env,
            GIT_PROJECT_ROOT: root,
            GIT_HTTP_EXPORT_ALL: "1",
            REQUEST_METHOD: request.method,
            PATH_INFO: url.pathname,
            QUERY_STRING: url.search.slice(1),
            CONTENT_TYPE: request.headers.get("content-type") ?? "",
            CONTENT_LENGTH: String(body.length),
            REMOTE_USER: "agent",
          },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
        })
        child.stdin.write(body)
        void child.stdin.end()
        const bytes = Buffer.from(await new Response(child.stdout).arrayBuffer())
        if ((await child.exited) !== 0) return new Response(null, { status: 500 })
        const split = bytes.indexOf("\r\n\r\n")
        const headers = new Headers()
        let status = 200
        for (const line of bytes.subarray(0, split).toString().split("\r\n")) {
          const at = line.indexOf(":")
          if (line.slice(0, at).toLowerCase() === "status")
            status = Number(
              line
                .slice(at + 1)
                .trim()
                .split(" ")[0],
            )
          else headers.set(line.slice(0, at), line.slice(at + 1).trim())
        }
        return new Response(bytes.subarray(split + 4), { status, headers })
      }
      if (auth !== "token test-installation-token" && auth !== "Bearer test-installation-token")
        return new Response(null, { status: 403 })
      if (url.pathname === "/repos/o/r/pulls" && request.method === "POST") {
        const body = Schema.decodeUnknownSync(
          Schema.Struct({ title: Schema.String, head: Schema.String }),
        )(await request.json())
        const sha = await command(["git", "-C", bare, "rev-parse", `refs/heads/${body.head}`])
        const pull = { number: pulls.length + 1, title: body.title, head: { ref: body.head, sha } }
        pulls.push(pull)
        return Response.json(pull, { status: 201 })
      }
      const match = /^\/repos\/o\/r\/pulls\/(\d+)$/.exec(url.pathname)
      return match && pulls[Number(match[1]) - 1]
        ? Response.json(pulls[Number(match[1]) - 1])
        : new Response(null, { status: 403 })
    },
  })
  const proxy = createServer()
  const sockets = new Set<import("node:net").Socket>()
  proxy.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  proxy.on("connect", (request, socket) => {
    if (!["github.com:443", "api.github.com:443"].includes(request.url ?? "")) {
      socket.destroy()
      return
    }
    const upstream = connect(github.port!, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      socket.pipe(upstream).pipe(socket)
    })
    upstream.on("error", () => socket.destroy())
    socket.on("close", () => upstream.destroy())
  })
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  const address = proxy.address()
  if (!address || typeof address === "string") throw new Error("proxy unavailable")
  const config = {
    directory: join(root, "broker-private"),
    socket: join(root, "broker.sock"),
    peer: { controllerUid, agentUid: uid, groupGid: gid },
    policies: [
      {
        name: "repo",
        repository: "o/r",
        installationId: 1,
        permissions: { contents: "write" as const, pull_requests: "write" as const },
      },
    ],
  }
  let setOpenCodeEnvironment:
    ((variables: Readonly<Record<string, string>>) => Promise<void>) | undefined
  const live = WorkerIdentityLive(config, fixture.github, fixture.OctokitClass, {
    serverId: "fixture",
    owningHostId: "fixture",
    providerId: "fixture",
    providerVersion: 1,
    endpointAlias: "fixture",
    endpointIdentity: "http://fixture",
    setSessionEnvironment: (input) =>
      Effect.tryPromise(() => {
        if (!setOpenCodeEnvironment) throw new Error("fixture session missing")
        return setOpenCodeEnvironment(input.variables)
      }).pipe(
        Effect.mapError(
          (cause) => new OpenCodeAdapterError({ operation: "fixture environment", cause }),
        ),
      ),
  }).pipe(
    Layer.provideMerge(AgentRunStoreLive),
    Layer.provideMerge(KernelSessionStoreLive),
    Layer.provideMerge(WorkflowStoreLive),
    Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
  )
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const identity = yield* WorkerIdentity
        const runs = yield* AgentRunStore
        for (const kind of ["codex", "claude", "opencode"] as const) {
          const home = join(root, kind),
            workspace = join(home, "work")
          yield* Effect.tryPromise(async () => {
            await mkdir(home, { mode: 0o700 })
            await chown(home, uid, gid)
            for (const directory of [
              workspace,
              join(home, ".codex"),
              join(home, ".claude"),
              join(home, "gh"),
            ]) {
              await mkdir(directory, { mode: 0o700 })
              await chown(directory, uid, gid)
            }
          })
          const env = {
            ...identity.environment(kind),
            HOME: home,
            CODEX_HOME: join(home, ".codex"),
            CLAUDE_CONFIG_DIR: join(home, ".claude"),
            PATH: process.env.PATH!,
            GH_CONFIG_DIR: join(home, "gh"),
            GIT_AUTHOR_NAME: "Fixture Agent",
            GIT_AUTHOR_EMAIL: "agent@example.test",
            GIT_COMMITTER_NAME: "Fixture Agent",
            GIT_COMMITTER_EMAIL: "agent@example.test",
            HTTPS_PROXY: `http://127.0.0.1:${address.port}`,
            HTTP_PROXY: `http://127.0.0.1:${address.port}`,
            NO_PROXY: "127.0.0.1,localhost",
            GIT_SSL_CAINFO: cert,
            SSL_CERT_FILE: cert,
            NODE_EXTRA_CA_CERTS: cert,
          }
          yield* Effect.tryPromise(() => command(asAgent(["git", "init", workspace]), env))
          yield* Effect.tryPromise(() =>
            command(
              asAgent([
                process.execPath,
                "-e",
                `import { Effect } from ${JSON.stringify(join(import.meta.dir, "../../node_modules/effect/dist/index.js"))}; import { installAgentGitGuard } from ${JSON.stringify(join(import.meta.dir, "../../src/agent-git/guard.ts"))}; await Effect.runPromise(installAgentGitGuard(${JSON.stringify(workspace)}, {name:"Fixture Agent",email:"agent@example.test",blockedEmails:["blocked@example.test"]}));`,
              ]),
              env,
              workspace,
            ),
          )
          yield* Effect.tryPromise(() =>
            command(
              asAgent(["git", "-C", workspace, "commit", "--allow-empty", "-m", "fixture"]),
              env,
            ),
          )
          const now = new Date()
          yield* runs.create({
            runId: kind,
            route: "fixture",
            providerId: kind === "opencode" ? kind : `${kind}-cli`,
            modelId: "fixture",
            agent: "build",
            repository: "repo",
            directory: workspace,
            prompt: "fixture",
            promptSha256: "a".repeat(64),
            parentSessionId: null,
            resumePrompt: null,
            maxAttempts: 1,
            createdAt: now,
          })
          yield* runs.claimSpawn({ runId: kind, now })
          const script = join(home, "publish.sh")
          const wrapper = `${quote(process.execPath)} ${quote(join(import.meta.dir, "../../src/worker-identity/command.ts"))}`
          yield* Effect.tryPromise(() =>
            writeFile(
              script,
              `set -eu\nid -u > ${quote(join(workspace, "uid"))}\n${wrapper} --git -- push https://github.com/o/r.git HEAD:refs/heads/${kind}\n${wrapper} -- api repos/o/r/pulls -f title=${kind} -f head=${kind} -f base=main --jq .number > ${quote(join(workspace, "pr"))}\n${wrapper} -- api repos/o/r/pulls/$(cat ${quote(join(workspace, "pr"))}) --jq .head.sha > ${quote(join(workspace, "sha"))}\nif ${wrapper} -- api repos/foreign/repo/pulls; then exit 20; fi\n`,
              { mode: 0o644 },
            ),
          )
          if (kind === "opencode") {
            const server = yield* Effect.tryPromise(() =>
              openCodePublisher(home, workspace, env, asAgent, `/bin/sh ${quote(script)}`),
            )
            try {
              const custody = yield* KernelSessionStore
              yield* custody.registerResource({
                resourceId: kind,
                owningHostId: "fixture",
                absolutePath: workspace,
                kind: "worktree",
                createdAt: now,
              })
              yield* custody.registerSession({
                sessionId: kind,
                nativeSessionId: server.sessionId,
                resourceId: kind,
                owningHostId: "fixture",
                providerKind: "opencode",
                providerVersion: 1,
                providerId: "fixture",
                serverId: "fixture",
                endpointAlias: "fixture",
                endpointIdentity: "http://fixture",
                createdAt: now,
              })
              yield* runs.markSpawned({
                runId: kind,
                resourceId: kind,
                sessionId: kind,
                nativeSessionId: server.sessionId,
                now,
              })
              setOpenCodeEnvironment = server.setEnvironment
              yield* identity.provision((yield* runs.read(kind))!)
              yield* Effect.tryPromise(() => server.prompt())
              expect(yield* Effect.tryPromise(() => readFile(join(workspace, "uid"), "utf8"))).toBe(
                `${uid}\n`,
              )
              expect(
                (yield* Effect.tryPromise(() => readFile(join(workspace, "sha"), "utf8"))).trim(),
              ).toBe(
                yield* Effect.tryPromise(() =>
                  command(["git", "-C", bare, "rev-parse", `refs/heads/${kind}`]),
                ),
              )
              expect(pulls.at(-1)?.head.ref).toBe(kind)
            } finally {
              yield* Effect.promise(() => server.close())
            }
            continue
          }
          const model = yield* Effect.tryPromise(() => nativeModelFixture(kind, root))
          const shell = `/bin/sh ${quote(script)}`
          model.actions.push({
            name: kind === "codex" ? "exec_command" : "Bash",
            arguments:
              kind === "codex"
                ? { cmd: shell, yield_time_ms: 1000 }
                : { command: shell, timeout: 30000 },
          })
          const argv =
            kind === "codex"
              ? [
                  model.binary,
                  ...codexProjectArguments(workspace),
                  "exec",
                  "--dangerously-bypass-approvals-and-sandbox",
                  "--skip-git-repo-check",
                  "-",
                ]
              : [
                  model.binary,
                  "--setting-sources",
                  "user",
                  "--dangerously-skip-permissions",
                  "-p",
                  "--output-format",
                  "json",
                ]
          const child = Bun.spawn(asAgent(argv), {
            cwd: workspace,
            env,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          })
          identity.register(kind, child.pid)
          child.stdin.write("Execute the fixture shell command and finish.\n")
          void child.stdin.end()
          try {
            const [output, errors, code] = yield* Effect.tryPromise(() =>
              Promise.all([
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
                child.exited,
              ]),
            )
            expect({ code, errors: errors.slice(-1000) }).toMatchObject({ code: 0 })
            if (!(yield* Effect.promise(() => Bun.file(join(workspace, "sha")).exists())))
              throw new Error(output.slice(-5000) + errors.slice(-5000))
            expect(yield* Effect.tryPromise(() => readFile(join(workspace, "uid"), "utf8"))).toBe(
              `${uid}\n`,
            )
            expect(
              (yield* Effect.tryPromise(() => readFile(join(workspace, "sha"), "utf8"))).trim(),
            ).toBe(
              yield* Effect.tryPromise(() =>
                command(["git", "-C", bare, "rev-parse", `refs/heads/${kind}`]),
              ),
            )
            expect(pulls.at(-1)?.head.ref).toBe(kind)
          } finally {
            if (child.exitCode === null) child.kill("SIGKILL")
            yield* Effect.promise(() => child.exited)
            yield* Effect.promise(() => model.close())
          }
        }
      }).pipe(Effect.provide(live)),
    )
    expect(pulls).toHaveLength(3)
    expect(fixture.bodies).toEqual([
      { repositories: ["r"], permissions: { contents: "write", pull_requests: "write" } },
    ])
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => proxy.close(() => resolve()))
    await github.stop(true)
    await fixture.close()
  }
}, 120000)

async function openCodePublisher(
  home: string,
  workspace: string,
  env: Record<string, string>,
  asAgent: (argv: string[]) => string[],
  shell: string,
) {
  let sent = false
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = Schema.decodeUnknownSync(
        Schema.Struct({
          tools: Schema.optional(
            Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String }) })),
          ),
        }),
      )(await request.json())
      const names = body.tools?.map((tool) => tool.function.name) ?? []
      const tool = !sent && names.length > 0
      if (tool) sent = true
      const name = names.includes("shell") ? "shell" : "execute"
      const args =
        name === "shell"
          ? { command: shell, description: "Publish fixture" }
          : {
              code: `return await tools.shell(${JSON.stringify({ command: shell, description: "Publish fixture" })})`,
            }
      const delta = tool
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "fixture-call",
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          }
        : { role: "assistant", content: "fixture complete" }
      const chunk = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`
      return new Response(
        chunk(delta, null) + chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const config = join(home, ".config/opencode")
  await command(asAgent(["mkdir", "-p", config]), env)
  const configFile = join(config, "opencode.json")
  await writeFile(
    configFile,
    JSON.stringify({
      update: "disable",
      share: "disabled",
      snapshots: false,
      formatter: false,
      lsp: false,
      providers: {
        fixture: {
          package: "aisdk:@ai-sdk/openai-compatible",
          settings: { baseURL: `${model.url.toString()}v1` },
          models: {
            fixture: {
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 100000, output: 1024 },
            },
          },
        },
      },
    }),
    { mode: 0o644 },
  )
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port!
  await reservation.stop(true)
  const shellEnv = {
    ...env,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local/state"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
  }
  const child = Bun.spawn(
    asAgent([Bun.which("opencode2")!, "serve", "--hostname", "127.0.0.1", "--port", String(port)]),
    {
      env: {
        ...shellEnv,
        OPENCODE_SERVER_PASSWORD: "synthetic-server",
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
      },
      cwd: workspace,
      stdout: "ignore",
      stderr: "ignore",
    },
  )
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/${path}?${new URLSearchParams({ "location[directory]": workspace }).toString()}`,
      {
        method: body === undefined ? "GET" : path.endsWith("/environment") ? "PUT" : "POST",
        headers: {
          authorization: `Basic ${Buffer.from("opencode:synthetic-server").toString("base64")}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30000),
      },
    )
    if (!response.ok)
      throw new Error(
        `fixture OpenCode API ${path} ${response.status}: ${(await response.text()).slice(0, 2000)}`,
      )
    const text = await response.text()
    return text ? (JSON.parse(text) as unknown) : undefined
  }
  const close = async () => {
    child.kill("SIGKILL")
    await child.exited
    await model.stop(true)
  }
  try {
    const deadline = Date.now() + 15000
    for (;;) {
      if (
        await api("model").then(
          (value) => JSON.stringify(value).includes('"id":"fixture"'),
          () => false,
        )
      )
        break
      if (Date.now() > deadline) throw new Error("fixture OpenCode startup timed out")
      await Bun.sleep(50)
    }
    await api("integration/fixture/connect/key", { key: "synthetic" })
    const session = Schema.decodeUnknownSync(
      Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }),
    )(await api("session", { agent: "build", model: { id: "fixture", providerID: "fixture" } }))
    return {
      sessionId: session.data.id,
      setEnvironment: async (variables: Readonly<Record<string, string>>) => {
        await api(`session/${session.data.id}/environment`, {
          variables: { ...variables, ...shellEnv },
        })
      },
      prompt: async () => {
        await api(`session/${session.data.id}/prompt`, { text: "Publish the fixture" })
        await api(`session/${session.data.id}/wait`, {})
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
