import { checkCredentialAdmission } from "../../src/agent-host/credentials"
import { relinkCredentials } from "../../src/agent-host/credential-relink"
import { credentialReason } from "../../src/agent-host/protocol"
import { spawnSync } from "node:child_process"
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

function probeEnvironment(home: string, path = "/usr/bin:/bin") {
  return {
    PATH: path,
    HOME: home,
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_STATE_HOME: join(home, "state"),
  }
}

function runtimePath() {
  const node = process.env.WORKFLOWD_AGENT_PROBE_NODE ?? Bun.which("node")
  if (!node) throw new Error("client_runtime_missing")
  return `${dirname(node)}:/usr/bin:/bin`
}

/** Only allow-listed metadata leaves the version subprocess; never raw CLI output. */
export async function probeClientVersions() {
  const root = await mkdtemp(join(tmpdir(), "workflowd-client-versions-"))
  const clients = [
    ["codex", "codex-cli 0.159.1", /^codex-cli \d+\.\d+\.\d+$/],
    ["claude", "2.1.296 (Claude Code)", /^\d+\.\d+\.\d+ \(Claude Code\)$/],
    ["opencode2", "opencode2 v0.0.0-beta-19242", /^opencode2 v\d+\.\d+\.\d+-beta-\d+$/],
  ] as const
  try {
    const versions = []
    for (const [client, expected, pattern] of clients) {
      const binary = Bun.which(client)
      if (!binary) throw new Error(`${client}: client_binary_missing`)
      const entrypoint = await realpath(binary)
      const inspect = (path: string) => {
        const result = spawnSync(binary, ["--version"], {
          cwd: root,
          env: probeEnvironment(root, path),
          encoding: "utf8",
          timeout: 15_000,
          maxBuffer: 64 * 1024,
        })
        const output = result.stdout?.trim() ?? ""
        return {
          exitCode: result.status,
          signal: result.signal,
          spawnFailed: result.error !== undefined,
          nodeAvailable: Bun.which("node", { PATH: path }) !== null,
          version: pattern.test(output) ? output : null,
        }
      }
      const original = inspect("/usr/bin:/bin")
      const pinned = inspect(runtimePath())
      console.log(JSON.stringify({ client, entrypoint, original, pinned }))
      if (pinned.spawnFailed || pinned.signal || pinned.exitCode !== 0)
        throw new Error(`${client}: client_abnormal_exit`)
      if (pinned.version !== expected) throw new Error(`${client}: client_version_mismatch`)
      versions.push({ client, version: pinned.version, exitCode: pinned.exitCode })
    }
    return versions
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** Installed-client prerequisite probe. All credentials and homes are synthetic. */
export async function probeCodexCredentialSharing() {
  const binary = Bun.which("codex")
  if (binary === null) throw new Error("Credential probe requires installed Codex")
  const root = await mkdtemp(join(tmpdir(), "workflowd-agent-credentials-"))
  const controller = join(root, "controller")
  const agent = join(root, "agent")
  const canonical = join(root, "auth.json")
  const authPath = (home: string) => join(home, ".codex", "auth.json")
  const command = (home: string, args: string[], input?: string) => {
    const result = spawnSync(binary, args, {
      cwd: root,
      env: probeEnvironment(home, runtimePath()),
      input,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    })
    if (result.error || result.signal !== null || result.status === null)
      throw new Error("Installed Codex probe did not finish normally")
    return result
  }
  const login = (home: string, value: string) => {
    const result = command(
      home,
      ["-c", 'cli_auth_credentials_store="file"', "login", "--with-api-key"],
      `${value}\n`,
    )
    if (result.status !== 0) throw new Error("Synthetic credential persistence failed")
  }
  const contains = async (path: string, value: string) => {
    const contents: unknown = JSON.parse(await readFile(path, "utf8"))
    return (
      typeof contents === "object" &&
      contents !== null &&
      "OPENAI_API_KEY" in contents &&
      contents.OPENAI_API_KEY === value
    )
  }
  try {
    for (const home of [controller, agent]) {
      await mkdir(join(home, ".codex"), { recursive: true, mode: 0o700 })
      await symlink(canonical, authPath(home))
    }
    await writeFile(canonical, JSON.stringify({ OPENAI_API_KEY: "synthetic-initial" }))
    await chmod(canonical, 0o660)
    const versionResult = command(controller, ["--version"])
    const version = versionResult.stdout.trim()
    if (versionResult.status !== 0) throw new Error("codex: client_abnormal_exit")
    if (version !== "codex-cli 0.159.1") throw new Error("codex: client_version_mismatch")

    login(controller, "synthetic-update")
    const directUpdateShared =
      (await contains(canonical, "synthetic-update")) &&
      (await contains(authPath(agent), "synthetic-update")) &&
      (await lstat(authPath(controller))).isSymbolicLink()

    if (command(controller, ["-c", 'cli_auth_credentials_store="file"', "logout"]).status !== 0)
      throw new Error("Synthetic credential logout failed")
    login(controller, "synthetic-relogin")
    const relogin = {
      controllerLinkPreserved: (await lstat(authPath(controller))).isSymbolicLink(),
      controllerSeesReplacement: await contains(authPath(controller), "synthetic-relogin"),
      canonicalSeesReplacement: await contains(canonical, "synthetic-relogin"),
      agentSeesReplacement: await contains(authPath(agent), "synthetic-relogin"),
    }
    await chmod(root, 0o710)
    const loginPaths = { canonical, benLink: authPath(controller), agentLink: authPath(agent) }
    const policy = {
      root,
      ownerUid: process.getuid!(),
      groupGid: process.getgid!(),
      controllerUid: process.getuid!(),
      agentUid: process.getuid!(),
      codex: loginPaths,
      claude: loginPaths,
      consumerExecutables: [],
    }
    const refusal = await checkCredentialAdmission(policy, "codex").then(
      () => undefined,
      credentialReason,
    )
    await relinkCredentials(policy, "codex", "ben")
    await checkCredentialAdmission(policy, "codex")
    return {
      refusal,
      repaired: await contains(authPath(agent), "synthetic-relogin"),
      provider: "codex",
      version,
      uidCount: 1,
      directUpdateShared,
      relogin,
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** The entire protocol fixture runs in a network namespace containing only loopback. */
export async function probeInstalledRefresh() {
  const root = await mkdtemp(join(tmpdir(), "workflowd-oauth-refresh-"))
  await chmod(root, 0o710)
  try {
    const child = Bun.spawn(
      [
        "systemd-run",
        ...(process.getuid?.() === 0 ? [] : ["--user"]),
        "--quiet",
        "--wait",
        "--pipe",
        "--collect",
        "-p",
        "MemoryMax=6G",
        "-p",
        "MemorySwapMax=0",
        "-p",
        "RuntimeMaxSec=120",
        "-p",
        "PrivateNetwork=yes",
        ...(process.getuid?.() === 0 ? [] : ["-p", "PrivateUsers=yes"]),
        `--setenv=PATH=${process.env.PATH}`,
        `--working-directory=${process.cwd()}`,
        ...[
          "WORKFLOWD_AGENT_TEST_BEN_UID",
          "WORKFLOWD_AGENT_TEST_AGENT_UID",
          "WORKFLOWD_AGENT_TEST_AUTH_GID",
        ].flatMap((key) => (process.env[key] ? [`--setenv=${key}=${process.env[key]}`] : [])),
        process.execPath,
        import.meta.filename,
        "--installed-refresh",
        root,
      ],
      { stdout: "pipe", stderr: "ignore" },
    )
    const output = await new Response(child.stdout).text()
    if ((await child.exited) !== 0) throw new Error("installed_refresh_probe_failed")
    const { Schema } = await import("effect")
    const evidence = Schema.decodeUnknownSync(
      Schema.Struct({
        egressDenied: Schema.Boolean,
        uidCount: Schema.Number,
        canariesDenied: Schema.Boolean,
        codex: Schema.Struct({ refreshPersisted: Schema.Boolean }),
        claude: Schema.Struct({
          refreshPersisted: Schema.Boolean,
          linkPreserved: Schema.Boolean,
          refusal: Schema.String,
          repaired: Schema.Boolean,
        }),
      }),
    )(JSON.parse(output))
    const store = join(root, "claude")
    const login = {
      canonical: join(store, ".credentials.json"),
      benLink: join(root, "claude-ben/.claude/.credentials.json"),
      agentLink: join(root, "claude-agent/.claude/.credentials.json"),
    }
    const policy = {
      root: store,
      ownerUid: process.getuid!(),
      groupGid: process.getgid!(),
      controllerUid: process.getuid!(),
      agentUid: process.getuid!(),
      codex: login,
      claude: login,
      consumerExecutables: [],
    }
    if (evidence.uidCount === 2) return evidence
    const refusal = await checkCredentialAdmission(policy, "claude").then(
      () => "",
      (error) => credentialReason(error) ?? "unknown",
    )
    await relinkCredentials(policy, "claude", "agent")
    await checkCredentialAdmission(policy, "claude")
    const repaired = (await readFile(login.benLink, "utf8")).includes("synthetic-rotated-refresh")
    return { ...evidence, claude: { ...evidence.claude, refusal, repaired } }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function installedRefresh(root: string) {
  const { createServer } = await import("node:http")
  const { createServer: createHttpsServer } = await import("node:https")
  const { connect } = await import("node:net")
  const { networkInterfaces } = await import("node:os")
  const uids = process.env.WORKFLOWD_AGENT_TEST_BEN_UID
    ? [
        Number(process.env.WORKFLOWD_AGENT_TEST_BEN_UID),
        Number(process.env.WORKFLOWD_AGENT_TEST_AGENT_UID),
      ]
    : [process.getuid!(), process.getuid!()]
  const group = Number(process.env.WORKFLOWD_AGENT_TEST_AUTH_GID ?? process.getgid!())
  const uidCount = new Set(uids).size
  if (
    process.env.WORKFLOWD_AGENT_TEST_BEN_UID &&
    (process.getuid!() !== 0 ||
      uidCount !== 2 ||
      uids.some((uid) => !Number.isSafeInteger(uid) || uid === 0))
  )
    throw new Error("two_uid_fixture_invalid")
  await chown(root, process.getuid!(), group)
  const egressDenied = Object.values(networkInterfaces())
    .flat()
    .every((entry) => entry?.internal)
  if (!egressDenied) throw new Error("external_egress_not_denied")
  const cert = join(root, "cert.pem")
  const key = join(root, "key.pem")
  const openssl = spawnSync(
    "/usr/bin/openssl",
    [
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
      "/CN=platform.claude.com",
      "-addext",
      "subjectAltName=DNS:platform.claude.com,DNS:api.anthropic.com",
    ],
    { stdio: "ignore" },
  )
  if (openssl.status !== 0) throw new Error("fixture_certificate_failed")
  let canariesDenied = uidCount === 1
  const oauth = { codex: 0, claude: 0 }
  const jwt = () =>
    `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: "fixture", exp: Math.floor(Date.now() / 1000) + 3600, email: "fixture@example.invalid", "https://api.openai.com/auth": { chatgpt_account_id: "fixture", chatgpt_plan_type: "plus" } })).toString("base64url")}.synthetic`
  // A CONNECT terminator, never a forwarding proxy. Only these two fixture hosts are accepted.
  const connections = new Set<import("node:net").Socket>()
  const http = createHttpsServer(
    { cert: await readFile(cert), key: await readFile(key) },
    (request, response) => {
      request.resume()
      request.on("end", () => {
        if (request.url?.startsWith("/v1/messages")) {
          const events: Array<readonly [string, unknown]> = [
            [
              "message_start",
              {
                type: "message_start",
                message: {
                  id: "fixture",
                  type: "message",
                  role: "assistant",
                  model: "claude-opus-4-6",
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 1, output_tokens: 0 },
                },
              },
            ],
            [
              "content_block_start",
              { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            ],
            [
              "content_block_delta",
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "synthetic fixture complete" },
              },
            ],
            ["content_block_stop", { type: "content_block_stop", index: 0 }],
            [
              "message_delta",
              {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: 1 },
              },
            ],
            ["message_stop", { type: "message_stop" }],
          ]
          response.setHeader("content-type", "text/event-stream")
          response.end(
            events
              .map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
              .join(""),
          )
        } else if (request.url === "/v1/oauth/token") {
          oauth.claude++
          response.setHeader("content-type", "application/json")
          response.end(
            JSON.stringify({
              access_token: "synthetic-rotated-access",
              refresh_token: "synthetic-rotated-refresh",
              expires_in: 3600,
              scope: "user:inference user:profile",
              token_type: "Bearer",
            }),
          )
        } else {
          response.setHeader("content-type", "application/json")
          response.end(
            JSON.stringify({
              account: { uuid: "fixture", email_address: "fixture@example.invalid" },
              organization: { uuid: "fixture", organization_type: "claude_max" },
            }),
          )
        }
      })
    },
  )
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const target = http.address()
  if (target === null || typeof target === "string") throw new Error("fixture_tls_failed")
  const proxy = createServer()
  proxy.on("connection", (socket) => {
    connections.add(socket)
    socket.on("close", () => connections.delete(socket))
  })
  proxy.on("connect", (request, socket) => {
    if (!["platform.claude.com:443", "api.anthropic.com:443"].includes(request.url ?? "")) {
      socket.destroy()
      return
    }
    const upstream = connect(target.port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      socket.pipe(upstream).pipe(socket)
    })
    upstream.on("error", () => socket.destroy())
    socket.on("close", () => upstream.destroy())
  })
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  const address = proxy.address()
  if (address === null || typeof address === "string") throw new Error("fixture_proxy_failed")
  const token = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      if (new URL(request.url).pathname !== "/")
        return Response.json(
          { error: { message: "synthetic revoked", type: "authentication_error" } },
          { status: 401 },
        )
      oauth.codex++
      return Response.json({
        access_token: jwt(),
        id_token: jwt(),
        refresh_token: "synthetic-rotated-refresh",
        expires_in: 3600,
      })
    },
  })
  const clients = ["codex", "claude"] as const
  const evidence = {
    codex: { refreshPersisted: true },
    claude: { refreshPersisted: true, linkPreserved: false, refusal: "", repaired: false },
  }
  try {
    for (const client of clients) {
      const store = join(root, client)
      await mkdir(store, { mode: 0o710 })
      await chown(store, process.getuid!(), group)
      const homes = [join(root, `${client}-ben`), join(root, `${client}-agent`)]
      const name = client === "codex" ? "auth.json" : ".credentials.json"
      const paths = homes.map((home) => join(home, `.${client}`, name))
      const canonical = join(store, name)
      for (const [index, home] of homes.entries()) {
        await mkdir(join(home, `.${client}`), { recursive: true, mode: 0o700 })
        await chown(home, uids[index]!, group)
        await chown(join(home, `.${client}`), uids[index]!, group)
        await writeFile(join(home, "private-canary"), "synthetic-private-config", { mode: 0o600 })
        await chown(join(home, "private-canary"), uids[index]!, group)
      }
      if (uidCount === 2) {
        canariesDenied = [0, 1].every(
          (index) =>
            spawnSync(
              "/usr/bin/setpriv",
              [
                "--reuid",
                String(uids[index]),
                "--regid",
                String(group),
                "--init-groups",
                "/usr/bin/cat",
                join(homes[1 - index]!, "private-canary"),
              ],
              { stdio: "ignore" },
            ).status !== 0,
        )
      }
      for (const path of paths) await symlink(canonical, path)
      const credentials =
        client === "codex"
          ? {
              auth_mode: "chatgpt",
              tokens: {
                id_token: jwt(),
                access_token: jwt(),
                refresh_token: "synthetic-initial-refresh",
                account_id: "fixture",
              },
              last_refresh: "2020-01-01T00:00:00Z",
            }
          : {
              claudeAiOauth: {
                accessToken: "synthetic-expired",
                refreshToken: "synthetic-initial-refresh",
                expiresAt: 1,
                scopes: ["user:inference", "user:profile"],
                subscriptionType: "max",
              },
            }
      for (const index of uidCount === 2 ? [0, 1] : [1]) {
        await writeFile(canonical, JSON.stringify(credentials), { mode: 0o660 })
        await chown(canonical, process.getuid!(), group)
        await chmod(canonical, 0o660)
        const env = {
          ...probeEnvironment(homes[index]!, runtimePath()),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          HTTP_PROXY: `http://127.0.0.1:${address.port}`,
          HTTPS_PROXY: `http://127.0.0.1:${address.port}`,
          ALL_PROXY: `http://127.0.0.1:${address.port}`,
          NO_PROXY: "127.0.0.1,localhost",
          NODE_EXTRA_CA_CERTS: cert,
          CODEX_REFRESH_TOKEN_URL_OVERRIDE: token.url.toString(),
        }
        const binary = Bun.which(client)
        if (!binary) throw new Error("client_binary_missing")
        // Refresh is followed by a model refusal for Codex; no tool turn is replayed.
        const command =
          client === "codex"
            ? [
                binary,
                "-c",
                'cli_auth_credentials_store="file"',
                "-c",
                `chatgpt_base_url="${token.url.toString()}"`,
                "exec",
                "--skip-git-repo-check",
                "--json",
                "synthetic fixture",
              ]
            : [
                binary,
                "-p",
                "synthetic fixture",
                "--output-format",
                "json",
                "--model",
                "claude-opus-4-6",
                "--tools",
                "",
              ]
        const child = Bun.spawn(
          uidCount === 2
            ? [
                "/usr/bin/setpriv",
                "--reuid",
                String(uids[index]),
                "--regid",
                String(group),
                "--init-groups",
                ...command,
              ]
            : command,
          { cwd: root, env, stdout: "ignore", stderr: "ignore" },
        )
        const timer = setTimeout(() => child.kill("SIGKILL"), 20000)
        try {
          await child.exited
        } finally {
          clearTimeout(timer)
        }
        const refreshed = (await readFile(paths[index]!, "utf8")).includes(
          "synthetic-rotated-refresh",
        )
        if (client === "codex")
          evidence.codex.refreshPersisted &&=
            oauth.codex > 0 &&
            refreshed &&
            (await readFile(canonical, "utf8")).includes("synthetic-rotated-refresh")
        else {
          evidence.claude.refreshPersisted &&= oauth.claude > 0 && refreshed
          evidence.claude.linkPreserved ||= (await lstat(paths[index]!)).isSymbolicLink()
          if (uidCount === 2) {
            const login = { canonical, benLink: paths[0]!, agentLink: paths[1]! }
            const policy = {
              root: store,
              ownerUid: 0,
              groupGid: group,
              controllerUid: uids[0]!,
              agentUid: uids[1]!,
              codex: login,
              claude: login,
              consumerExecutables: [],
            }
            evidence.claude.refusal = await checkCredentialAdmission(policy, "claude").then(
              () => "",
              (error) => credentialReason(error) ?? "unknown",
            )
            await relinkCredentials(policy, "claude", index === 0 ? "ben" : "agent")
            await checkCredentialAdmission(policy, "claude")
            evidence.claude.repaired = (await readFile(paths[1 - index]!, "utf8")).includes(
              "synthetic-rotated-refresh",
            )
          }
        }
      }
    }
    return { egressDenied, uidCount, canariesDenied, ...evidence }
  } finally {
    await token.stop(true)
    for (const socket of connections) socket.destroy()
    proxy.closeAllConnections()
    proxy.close()
    http.closeAllConnections()
    http.close()
  }
}

if (import.meta.main && process.argv[2] === "--installed-refresh") {
  try {
    console.log(JSON.stringify(await installedRefresh(process.argv[3]!)))
  } catch (error) {
    console.log(
      JSON.stringify({ reason: credentialReason(error) ?? "installed_refresh_probe_failed" }),
    )
    process.exitCode = 1
  }
}
