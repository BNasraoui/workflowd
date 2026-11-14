import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { Cause, Context, Effect, Exit, Layer, Schedule, Scope, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { FetchHttpClient } from "effect/unstable/http"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { OpenCode } from "@opencode-ai/client/effect"
import { AgentRunStore, AgentRunStoreLive } from "../../../src/kernel/agent-run-store"
import { AgentRunIngress, AgentRunIngressLive } from "../../../src/kernel/agent-run-ingress"
import { AgentRunWorktrees } from "../../../src/kernel/agent-run-worktrees"
import { CodexCli } from "../../../src/kernel/codex-session"
import { KernelSessionStoreLive } from "../../../src/kernel/session-store"
import { WorkflowStoreLive } from "../../../src/store"
import { WorkSignalLive } from "../../../src/work-signal"
import { routeRequest } from "../../../src/http"
import { makeCapabilityGateway } from "../../../src/capability-gateway/service"
import { makeNativeExecutionStore } from "../../../src/sandbox/native-execution"
import { makeNativeResultStore } from "../../../src/sandbox/native-result"
import { makeSandboxDispatch, SandboxDispatch } from "../../../src/sandbox/dispatch"
import { makeSandboxLeaseService } from "../../../src/sandbox/lease"
import { makeSandboxStore } from "../../../src/sandbox/store"
import { makeSandboxGithub } from "../../../src/sandbox/github"
import { makePublishStore, ResultMetadata } from "../../../src/sandbox/publish-store"
import { sandboxGithubFixture, sandboxPublicationFixture } from "../harness"
import { exchangeJobProof, verifyJobProof } from "../../../src/sandbox/bootstrap"
import { makeCapabilityTransport } from "../../../src/sandbox/capability-transport"
import { sandboxSshArguments } from "../../../src/sandbox/transport"
import { makeOpenCodeSdkClient, SdkOpenCodeAdapter } from "../../../src/opencode/adapter"
import { disposableSsh } from "./ssh.mjs"
import type { PassThrough } from "node:stream"
import type { CliPort } from "../../../src/kernel/cli-process-contract"
import { WorkspaceError } from "../../../src/workspace/errors"
import { ExecutionDiscovery, makeExecutionCapabilities } from "../../../src/execution-capabilities"

const Launch = Schema.Struct({
  client: Schema.optionalKey(Schema.Literals(["codex", "opencode"])),
  provider: Schema.optionalKey(Schema.String),
  nonce: Schema.String,
  session: Schema.String,
  model: Schema.String,
  effort: Schema.String,
  prompt: Schema.String,
  deadline: Schema.Number,
})
type Invocation = NonNullable<
  Effect.Success<ReturnType<Effect.Success<typeof makeNativeExecutionStore>["read"]>>
>

/** Real ingress/dispatch/SQL/HTTP/gateway/SSH/native process lifecycle. GitHub
 * lease acquisition and release are explicit synthetic boundaries. The exact
 * resulting artifact is separately tested with the local candidate publisher. */
export async function makeOwnedApplication(root: string, input: unknown, sourceSha: string) {
  const initial = Schema.decodeUnknownSync(Launch)(input)
  const kind = initial.client ?? "claude"
  const provider = initial.provider ?? "anthropic"
  const scope = Effect.runSync(Scope.make())
  const ssh = await disposableSsh(
    () => "/bin/node /source/native-owned-job.mjs",
    "127.0.0.1",
    22222,
    `${root}/ssh-diagnostic.log`,
    "runner",
  )
  const servers: Array<{ stop(close?: boolean): unknown }> = []
  let expectedScopeFailure = false
  const close = async () => {
    try {
      for (const server of servers) await server.stop(true)
      const exit = await Effect.runPromiseExit(Scope.close(scope, Exit.void))
      if (expectedScopeFailure) assert.equal(exit._tag, "Failure")
      else if (exit._tag === "Failure")
        throw new Error("Owned application finalization failed", { cause: exit.cause })
    } finally {
      await ssh.close()
    }
  }
  try {
    await mkdir(`${root}/noscope/providers`, { recursive: true, mode: 0o700 })
    assert.ok(process.env.NIX_LD?.startsWith("/nix/store/"))
    assert.ok(process.env.NIX_LD_LIBRARY_PATH?.startsWith("/nix/store/"))
    await writeFile(
      `${root}/noscope-elf`,
      `#!/bin/sh\nexport NIX_LD=${JSON.stringify(process.env.NIX_LD)}\nexport NIX_LD_LIBRARY_PATH=${JSON.stringify(process.env.NIX_LD_LIBRARY_PATH)}\nexec /source/noscope "$@"\n`,
      { mode: 0o700 },
    )
    await writeFile(
      `${root}/access.mjs`,
      `console.log(JSON.stringify({token:${JSON.stringify(kind === "codex" ? JSON.stringify({ accessToken: "fixture-access", accountId: "fixture-account" }) : "fixture-access")},token_id:"fixture",expires_at:new Date(Date.now()+120000).toISOString()}))`,
    )
    for (const [name, command] of [
      ["run-capability", "/bin/bun /source/native-owned-provider.mjs run {ttl}"],
      ["provider-access", `/bin/bun ${root}/access.mjs`],
    ])
      await writeFile(
        `${root}/noscope/providers/${name}.toml`,
        `contract_version = 1\n[commands]\nmint = "${command}"\n`,
        { mode: 0o600 },
      )
    const database = SqliteClient.layer({ filename: `${root}/application.sqlite` })
    const context = await Effect.runPromise(
      Scope.provide(
        Layer.build(
          Layer.mergeAll(AgentRunStoreLive, KernelSessionStoreLive, WorkSignalLive).pipe(
            Layer.provideMerge(WorkflowStoreLive.pipe(Layer.provideMerge(database))),
          ),
        ),
        scope,
      ),
    )
    return await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO directory_local_identity(singleton,host_id) VALUES(1,'fixture-controller')`
        const runs = yield* AgentRunStore
        const leases = yield* makeSandboxStore
        const native = yield* makeNativeExecutionStore
        const results = yield* makeNativeResultStore
        const unused = () => Effect.die("Unexpected external service in owned native fixture")
        const policy = {
          alias: "fixture",
          repository: "fixture/repo",
          repositoryId: 12,
          installationId: 1,
          workflowSha: "a".repeat(40),
          appActorId: 56,
          agentImage: "ghcr.io/bnasraoui/workflowd-agent-base@sha256:" + "b".repeat(64),
          tailscaleClientId: "fixture",
          tailscaleAudience: "fixture",
          privateBootstrap: { mode: "actions-native" as const, repositoryOwnerId: 1 },
          publish: {
            baseRef: "main",
            environmentId: 9,
            publisherAppId: 5232172,
            publisherActorId: 339414993,
            coAuthor: "Ben Nasraoui <81005232+BNasraoui@users.noreply.github.com>",
          },
        }
        let runId = ""
        const fixture = yield* Effect.promise(() => sandboxGithubFixture(policy))
        servers.push({ stop: () => fixture.close() })
        const publication = sandboxPublicationFixture(fixture, policy, "", "none", "", {
          actionsRunId: 78,
          leaseId: () => runId,
          metadata: async () => {
            const receipt = Schema.decodeUnknownSync(Schema.Struct({ metadata: Schema.String }))(
              await Bun.file(`${root}/native/capture-receipt.json`).json(),
            )
            return Schema.decodeUnknownSync(Schema.fromJsonString(ResultMetadata))(receipt.metadata)
          },
        })
        const publicationGithub = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const publications = yield* makePublishStore
        const github: Effect.Success<ReturnType<typeof makeSandboxGithub>> = {
          gateAppId: 1,
          repositoryUrl: () => "http://synthetic/fixture/repo",
          publicationRead: publicationGithub.publicationRead,
          publishRequest: publicationGithub.publishRequest,
          ensureRef: unused,
          runs: unused,
          savedRun: publicationGithub.savedRun,
          inventory: unused,
          cancel: unused,
          deleteRef: unused,
          readiness: unused,
          resolveSource: () => Effect.succeed(sourceSha),
          verifyWorkflow: () => Effect.succeed(undefined),
        }
        let traces = 0
        const trace = async (value: object) => {
          assert.ok(++traces <= 128)
          await appendFile(
            `${root}/gateway-lifecycle.jsonl`,
            JSON.stringify({ at: Date.now(), ...value }) + "\n",
            { mode: 0o600 },
          )
        }
        const gateway = yield* makeCapabilityGateway(
          {
            noscope: { binary: `${root}/noscope-elf`, configHome: root },
            providerId: provider,
            ...(kind === "claude"
              ? {}
              : {
                  native: {
                    protocol:
                      kind === "codex" ? ("codex-chatgpt" as const) : ("openai-chat" as const),
                    models: [{ id: initial.model, efforts: ["high" as const] }],
                  },
                }),
            credentialRole: "fixture",
            maxStreams: 4,
            maxStreamsPerRun: 4,
          },
          async (_url, input) => {
            await trace({ stage: "upstream" })
            return fetch(
              "http://synthetic" +
                (kind === "claude"
                  ? "/v1/messages"
                  : kind === "codex"
                    ? "/responses"
                    : "/chat/completions"),
              {
                ...input,
                unix: `${root}/upstream.sock`,
              },
            )
          },
        )
        const capabilityTransport = yield* makeCapabilityTransport(gateway, "/bin/node", root)
        const remote = yield* makeSandboxLeaseService(github, `${root}/leases`)
        const client = yield* OpenCode.make({ baseUrl: "http://127.0.0.1:1" }).pipe(
          Effect.provide(FetchHttpClient.layer),
        )
        const service = yield* makeSandboxDispatch({
          nativeScope: scope,
          publicationContract: { reference: "fixture-only:worktree", receipt: "fixed-v1" },
          policies: [policy],
          github,
          client,
          executor: new SdkOpenCodeAdapter(makeOpenCodeSdkClient(Effect.succeed(client))),
          executorId: "opencode:unused",
          endpointIdentity: "http://127.0.0.1:1",
          leases: {
            ...remote,
            acquire: (runId) =>
              Effect.gen(function* () {
                yield* leases.beginStart(runId)
                yield* leases.recordRun(runId, 78, 1)
                fixture.savedRun(78, { head_branch: `workflowd/leases/${runId}` })
                const transport = {
                  leaseId: runId,
                  peerId: "fixture-peer",
                  address: "127.0.0.1",
                  port: 22222,
                  repositoryPath: "/workspace/repository" as const,
                  knownHostsFile: `${ssh.root}/known_hosts`,
                  identityFile: `${ssh.root}/client`,
                }
                const challenge = yield* gateway.challenge(runId, transport)
                const audience = `workflowd:${challenge.channel}:${challenge.nonce}`
                const lease = yield* leases.read(runId)
                assert.ok(lease)
                const { publicKey, privateKey } = generateKeyPairSync("rsa", {
                  modulusLength: 2048,
                })
                const ref = `refs/heads/workflowd/leases/${lease.lease_id}`
                const expected = {
                  audience,
                  repository: policy.repository,
                  repositoryId: 12,
                  ownerId: 1,
                  actorId: 56,
                  ref,
                  workflowSha: policy.workflowSha,
                  toolingSha: "f74e0505155bc32aa2cedef00ba8b08ef1b90007",
                  workflowRef: `fixture/repo/.github/workflows/agent-sandbox-caller.yml@${ref}`,
                  jobWorkflowRef:
                    "BNasraoui/workflowd/.github/workflows/agent-sandbox.yml@f74e0505155bc32aa2cedef00ba8b08ef1b90007",
                  runId: 78,
                  attempt: 1,
                }
                const now = Math.floor(Date.now() / 1000)
                const claims = {
                  iss: "https://token.actions.githubusercontent.com",
                  aud: expected.audience,
                  sub: "repo:fixture@1/repo@12:ref:" + expected.ref,
                  jti: "owned-native-job",
                  iat: now,
                  nbf: now,
                  exp: now + 120,
                  repository: expected.repository,
                  repository_id: "12",
                  repository_owner_id: "1",
                  repository_owner: "fixture",
                  actor_id: "56",
                  ref: expected.ref,
                  sha: expected.workflowSha,
                  workflow_ref: expected.workflowRef,
                  workflow_sha: expected.workflowSha,
                  job_workflow_ref: expected.jobWorkflowRef,
                  job_workflow_sha: expected.toolingSha,
                  run_id: "78",
                  run_attempt: "1",
                  event_name: "push",
                  runner_environment: "github-hosted",
                }
                const encoded = [{ alg: "RS256", typ: "JWT", kid: "fixture" }, claims]
                  .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
                  .join(".")
                const token =
                  encoded +
                  "." +
                  sign("RSA-SHA256", Buffer.from(encoded), privateKey).toString("base64url")
                const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "fixture" }] }
                assert.throws(() =>
                  verifyJobProof(token, { ...expected, attempt: 2 }, jwks, Date.now()),
                )
                yield* Effect.promise(async () => {
                  await writeFile(
                    `${root}/bootstrap-input.json`,
                    JSON.stringify({
                      audience,
                      token,
                      identity: {
                        peerId: transport.peerId,
                        agentImage: policy.agentImage,
                        workflowSha: policy.workflowSha,
                      },
                    }),
                    { mode: 0o600 },
                  )
                  const child = Bun.spawn(["/bin/node", "/source/native-owned-bootstrap.mjs"], {
                    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
                    stdin: "ignore",
                    stdout: "pipe",
                    stderr: "pipe",
                  })
                  const diagnostics = (async () => {
                    let text = ""
                    for await (const bytes of child.stderr) {
                      text += new TextDecoder().decode(bytes)
                      assert.ok(text.length <= 4096)
                    }
                    await writeFile(`${root}/runner-relay.log`, text, { mode: 0o600 })
                  })()
                  void diagnostics.catch(() => child.kill("SIGKILL"))
                  servers.push({
                    async stop() {
                      child.kill("SIGTERM")
                      await child.exited
                      await diagnostics
                    },
                  })
                  const ready = await child.stdout.getReader().read()
                  assert.equal(ready.done, false)
                  assert.equal(Buffer.from(ready.value ?? []).toString(), "ready\n")
                })
                let grant: Effect.Success<ReturnType<typeof gateway.bind>> | undefined
                yield* Effect.tryPromise((signal) =>
                  exchangeJobProof(
                    [
                      ...sandboxSshArguments(transport).slice(0, -1),
                      "exec /usr/local/bin/runner-control bootstrap",
                    ],
                    { audience, peerId: transport.peerId },
                    async (proof, signal) => {
                      const received = Schema.decodeUnknownSync(
                        Schema.Struct({
                          token: Schema.String,
                          peerId: Schema.Literal(transport.peerId),
                          agentImage: Schema.Literal(policy.agentImage),
                          workflowSha: Schema.Literal(policy.workflowSha),
                        }),
                      )(proof)
                      grant = await Effect.runPromise(
                        gateway.bind(
                          challenge,
                          verifyJobProof(received.token, expected, jwks, Date.now()).jti,
                        ),
                        { signal },
                      )
                      return {
                        mode: "actions-native",
                        token: grant.token,
                        expiresAt: grant.expiresAt,
                        renewAt: grant.renewAt,
                        deadline: lease.deadline,
                      }
                    },
                    signal,
                  ),
                )
                assert.ok(grant)
                yield* capabilityTransport.connect(grant.binding, transport)
                yield* Effect.promise(() =>
                  writeFile(
                    `${root}/bootstrap-receipt.json`,
                    JSON.stringify({
                      signedChallenge: true,
                      foreignAttemptRefused: true,
                      authenticatedSsh: true,
                      productionBootstrap: true,
                      productionHttp2Relay: true,
                    }),
                    { mode: 0o600 },
                  ),
                )
                yield* leases.bind(runId, 78, 1, transport)
                return (yield* leases.read(runId))!
              }),
            release: (runId) =>
              Effect.gen(function* () {
                assert.equal((yield* native.read(runId))?.state, "stopped")
                yield* leases.beginRelease(runId)
                for (const row of yield* leases.cleanupRuns()) {
                  assert.equal(row.lease_id, runId)
                  yield* leases.cleanupState(row, "terminated")
                  yield* leases.finishCleanup(row, Effect.void, Effect.void)
                }
              }),
            // Synthetic Actions job/artifact scheduling; capture itself uses the
            // real SSH native-result operation before this boundary is reached.
            finish: () => Effect.sync(() => assert.ok(publication.posts <= 1)),
          },
        })
        let permitted = Promise.withResolvers<void>()
        let prepared = Promise.withResolvers<Invocation>()
        let invocation: Invocation
        let settlements = 0
        let execution: CliPort | undefined
        const terminal = Promise.withResolvers<void>()
        const prepare = (id: string) =>
          Effect.gen(function* () {
            runId = id
            const saved = yield* native.read(runId)
            assert.ok(saved)
            invocation = saved
            yield* Effect.promise(() =>
              writeFile(`${root}/native-deadline`, String(saved.deadline), { mode: 0o600 }),
            )
            prepared.resolve(saved)
            // Synchronization only: the caller must finish opening its synthetic
            // upstream before the real native process is allowed to start.
            yield* Effect.promise(() => permitted.promise)
          }).pipe(Effect.orDie)
        const sandbox = {
          ...service,
          prepareNative: (run: Parameters<typeof service.prepareNative>[0]) =>
            service.prepareNative(run).pipe(
              Effect.tap((attachment) => {
                execution = attachment.cli
                return prepare(run.runId)
              }),
            ),
          resumeNative: (run: Parameters<typeof service.resumeNative>[0], nonce: string) =>
            service.resumeNative(run, nonce).pipe(Effect.tap(() => prepare(run.runId))),
          finishNative: (...args: Parameters<typeof service.finishNative>) =>
            service.finishNative(...args).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  settlements++
                  terminal.resolve()
                }),
              ),
            ),
        }
        const discovery = makeExecutionCapabilities({
          host: "fixture-controller",
          refreshMs: 60000,
          timeoutMs: 1000,
          sources: [
            {
              executor: `${kind}:actions`,
              kind,
              host: "github-actions",
              evidence: "configured",
              discover: async () => [
                {
                  provider,
                  model: initial.model,
                  availability: "unknown",
                  defaultEffort: "high",
                  efforts: [{ id: "high" }],
                  ...(kind === "opencode" ? { variants: [{ id: "high", effort: "high" }] } : {}),
                },
              ],
            },
          ],
        })
        yield* Effect.addFinalizer(() => Effect.promise(discovery.close))
        const ingressContext = yield* Layer.build(
          AgentRunIngressLive({
            routes:
              kind === "opencode"
                ? [{ name: "native", providerID: provider, modelID: initial.model }]
                : [],
            codexRoutes: kind === "codex" ? [{ name: "native", modelID: initial.model }] : [],
            claudeRoutes: kind === "claude" ? [{ name: "native", modelID: initial.model }] : [],
            repositories: [{ name: "fixture", directory: "/fixture/repo" }],
            sandboxRepositories: [policy],
            agent: "sandbox",
            worktreeRoot: `${root}/worktrees`,
            // Match the configured production default, including remote container startup.
            verifyTimeoutMs: 120000,
            verifyPollIntervalMs: 10,
            progressWindowMs: 30000,
            maxAttempts: 1,
            claudeHosts: [],
            identity: {
              owningHostId: "fixture-controller",
              providerId: provider,
              serverId: "fixture-controller",
              endpointAlias: "local",
              endpointIdentity: "http://127.0.0.1:1",
              providerVersion: 1,
            },
          }).pipe(
            Layer.provide(Layer.succeedContext(context)),
            Layer.provide(Layer.succeed(SandboxDispatch, sandbox)),
            Layer.provide(
              Layer.succeed(ExecutionDiscovery, { list: () => Effect.tryPromise(discovery.list) }),
            ),
            Layer.provide(Layer.succeed(AgentRunWorktrees, { create: unused })),
            Layer.provide(
              Layer.succeed(CodexCli, {
                ownership: "transient-exec",
                preflight: Effect.void,
                attach: () => Effect.succeed(null),
                spawn: unused,
              }),
            ),
          ),
        )
        const ingress = Context.get(ingressContext, AgentRunIngress)
        const controllerToken = "fixture-controller-private"
        servers.push(
          Bun.serve({
            unix: `${root}/controller.sock`,
            fetch: (request) =>
              Effect.runPromise(
                routeRequest(request, {
                  installationIds: new Set<number>(),
                  webhookSecret: "fixture",
                  now: new Date(),
                  agentRuns: { token: controllerToken, ...ingress },
                }).pipe(Effect.provide(context)),
              ),
          }),
        )
        const http = (path: string, body: unknown, token = controllerToken) =>
          fetch("http://controller" + path, {
            unix: `${root}/controller.sock`,
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        const control = (body: unknown, token = controllerToken) =>
          http(`/workflows/agent-runs/${runId}/native`, body, token)
        const pendingReceipt = async (response: Promise<Response>, status = 200) => {
          const value = await response
          assert.equal(value.status, status, await value.clone().text())
          return Schema.decodeUnknownSync(
            Schema.Struct({
              nonce: Schema.optionalKey(Schema.String),
              state: Schema.optionalKey(Schema.String),
            }),
          )(await value.json())
        }
        const request = () => ({
          ...initial,
          nonce: invocation.nonce,
          container: invocation.container_nonce,
          session: invocation.session_id,
          predecessor: invocation.predecessor,
          resume: invocation.generation > 1,
          deadline: invocation.deadline,
        })
        const identity = () =>
          Effect.runPromise(
            Effect.gen(function* () {
              const run = yield* runs.read(runId)
              assert.ok(run)
              return {
                runId,
                session: run.sessionId,
                native: run.nativeSessionId,
                resource: run.resourceId,
                mailbox: run.callerMailboxId,
                provider: run.providerId,
                executor: run.executorKind,
                selection: run.resolvedSelection,
                managed:
                  yield* sql`SELECT recipient_id,host_id FROM directory_managed WHERE run_id=${runId}`,
                endpoint:
                  yield* sql`SELECT server_id,endpoint_identity FROM kernel_sessions WHERE native_session_id=${run.nativeSessionId}`,
              }
            }),
          )
        let savedIdentity: Awaited<ReturnType<typeof identity>> | undefined
        let pending = pendingReceipt(
          http("/workflows/agent-runs", {
            route: "native",
            repository: "fixture",
            prompt: initial.prompt,
          }),
          202,
        )
        void pending.catch((error) => prepared.reject(error))
        yield* Effect.promise(() => prepared.promise)
        const execute = async (
          input: ReturnType<typeof request>,
          commands: PassThrough,
          event: (value: unknown) => void,
        ) => {
          permitted.resolve()
          await pending
          const currentIdentity = await identity()
          if (savedIdentity) assert.deepEqual(currentIdentity, savedIdentity)
          else savedIdentity = currentIdentity
          assert.equal(currentIdentity.selection?.executor, `${kind}:actions`)
          assert.equal(currentIdentity.selection?.host, "github-actions:78:1")
          assert.equal(currentIdentity.selection?.evidence, "provider-response")
          assert.deepEqual(currentIdentity.managed, [
            { recipient_id: `managed:fixture-controller:${runId}`, host_id: "fixture-controller" },
          ])
          assert.deepEqual(currentIdentity.endpoint, [
            {
              server_id: "github-actions:78:1",
              endpoint_identity: `${kind}-cli://github-actions:78:1`,
            },
          ])
          assert.equal((await control({ operation: "status" }, "workflowd-local")).status, 401)
          assert.equal((await control({ operation: "pause", nonce: "a".repeat(64) })).status, 409)
          const status = await pendingReceipt(control({ operation: "status" }))
          assert.equal(status.nonce, input.nonce)
          assert.equal(status.state, "running")
          if (!input.resume)
            for await (const bytes of commands) {
              assert.ok(Buffer.isBuffer(bytes))
              const command = Schema.decodeUnknownSync(
                Schema.fromJsonString(Schema.Struct({ operation: Schema.Literal("pause") })),
              )(bytes.toString())
              const candidate = await Effect.runPromise(results.read(runId))
              assert.ok(candidate)
              const mutation = {
                operation: command.operation,
                nonce: input.nonce,
              }
              const concurrent = await Promise.all([control(mutation), control(mutation)])
              assert.deepEqual(concurrent.map((value) => value.status).sort(), [200, 409])
              const accepted = concurrent.find((value) => value.status === 200)
              assert.ok(accepted)
              const result = await pendingReceipt(Promise.resolve(accepted))
              assert.equal(result.state, "paused")
              assert.equal(
                (
                  await control({
                    operation: command.operation,
                    nonce: input.nonce,
                  })
                ).status,
                409,
              )
              commands.end()
            }
          if (input.resume) {
            // Exercise the ordinary controller observation pass. No fixture
            // command selects completion or calls the administrative finish API.
            await Effect.runPromise(
              Effect.gen(function* () {
                const run = yield* runs.read(runId)
                assert.ok(run)
                yield* service.observe(run)
                return (yield* native.read(runId))?.finalize_claimed === 1
              }).pipe(
                Effect.repeat({
                  until: (claimed) => claimed,
                  schedule: Schedule.spaced("100 millis"),
                }),
                Effect.timeout("20 seconds"),
              ),
            )
            await Effect.runPromise(
              Effect.promise(() => terminal.promise).pipe(Effect.timeout("15 seconds")),
            )
            const candidate = await Effect.runPromise(results.read(runId))
            assert.ok(candidate)
            const run = await Effect.runPromise(runs.read(runId))
            assert.ok(run)
            assert.equal(run.state, "verified")
            assert.equal((await Effect.runPromise(publications.read(runId)))?.phase, "approved")
            assert.equal(
              (
                await Effect.runPromise(
                  sql`SELECT id FROM resident_inbox WHERE id=${"agent-run-end-" + runId}`,
                )
              ).length,
              0,
            )
            await Effect.runPromise(service.observe(run))
            const published = await Effect.runPromise(publications.read(runId))
            assert.equal(published?.phase, "published")
            assert.equal(published?.metadata.title, candidate.completion.title)
            assert.equal(publication.posts, 1)
            assert.equal(publication.downloads, 0)
            if (kind !== "claude") {
              const diagnostics = Schema.decodeUnknownSync(
                Schema.Struct({
                  protocol: Schema.String,
                  requestId: Schema.String,
                  quota: Schema.Record(Schema.String, Schema.Number),
                }),
              )(await Bun.file(`${run.directory}/provider-response.json`).json())
              assert.equal(diagnostics.protocol, kind === "codex" ? "codex-chatgpt" : "openai-chat")
              assert.match(diagnostics.requestId, /^req-private-fixture-\d+$/)
              assert.deepEqual(diagnostics.quota, {
                [kind === "codex"
                  ? "x-codex-primary-used-percent"
                  : "x-ratelimit-remaining-requests"]: 42,
              })
              assert.ok(!JSON.stringify(published).includes("req-private-fixture-"))
              await writeFile(
                `${root}/private-provider-evidence.json`,
                JSON.stringify(diagnostics),
                { mode: 0o600 },
              )
            }
            await writeFile(
              `${root}/controller-publication.json`,
              JSON.stringify({
                capturedOverSsh: true,
                automaticFinalization: true,
                administrativeFinishCalls: 0,
                approvalPosts: publication.posts,
                controllerArtifactDownloads: publication.downloads,
                publication: published,
                syntheticGithubAndPublisherReadback: true,
              }),
              { mode: 0o600 },
            )
          }
          const current = await Effect.runPromise(native.read(runId))
          assert.ok(current)
          invocation = current
          input.session = current.session_id
          const inbox = await Effect.runPromise(
            sql`SELECT id,mailbox_id,prompt FROM resident_inbox WHERE id=${"agent-run-end-" + runId}`,
          )
          assert.equal(inbox.length, current.state === "paused" ? 0 : 1)
          assert.equal(settlements, current.state === "paused" ? 0 : 1)
          assert.ok(!JSON.stringify(inbox).includes("req-private-fixture-"))
          if (current.state === "paused")
            assert.equal((await Effect.runPromise(runs.read(runId)))?.state, "verified")
          else {
            assert.equal((await Effect.runPromise(runs.read(runId)))?.state, "completed")
            assert.equal(inbox[0]!.mailbox_id, currentIdentity.mailbox)
            const notification = Schema.decodeUnknownSync(
              Schema.fromJsonString(
                Schema.Struct({ native_session_id: Schema.String, status: Schema.String }),
              ),
            )(inbox[0]!.prompt)
            assert.equal(notification.native_session_id, current.session_id)
            assert.equal(notification.status, "completed")
            await Effect.runPromise(service.observe((await Effect.runPromise(runs.read(runId)))!))
            assert.equal(
              (
                await Effect.runPromise(
                  sql`SELECT id FROM resident_inbox WHERE id=${"agent-run-end-" + runId}`,
                )
              ).length,
              1,
            )
          }
          event({ event: "started", nonce: current.nonce, session: current.session_id })
          event({
            event: "closed",
            nonce: current.nonce,
            session: current.session_id,
            outcome: current.outcome,
            stopped: current.state === "stopped" || current.state === "paused",
          })
          await writeFile(
            `${root}/application-${current.generation}.json`,
            JSON.stringify({
              invocation: current,
              identity: currentIdentity,
              inbox,
              settlements,
              externalHttpControl: true,
            }),
          )
          return current.outcome
        }
        return {
          request: request(),
          execute,
          close,
          candidate: () => Effect.runPromise(results.read(runId)),
          capture: () => Effect.runPromise(remote.finishResult(runId, "ignored model prose")),
          async fault(beforeStop: () => Promise<void>) {
            permitted.resolve()
            await pending
            await beforeStop()
            assert.ok(execution?.ownership === "transient-exec")
            const process = await Effect.runPromise(execution.attach({ runId }))
            assert.ok(process)
            await Effect.runPromise(sql`CREATE TRIGGER fail_owned_revocation BEFORE UPDATE OF revoked ON capability_bindings
            BEGIN SELECT RAISE(FAIL,'injected owned-container revocation failure'); END`)
            const failure = await Effect.runPromiseExit(remote.stopNative(runId))
            assert.equal(failure._tag, "Failure")
            const closure = await Effect.runPromiseExit(
              process.exited.pipe(Effect.timeout("15 seconds")),
            )
            assert.ok(Exit.isFailure(closure))
            assert.ok(
              Cause.squash(closure.cause) instanceof WorkspaceError,
              "Expected joined SSH custody failure, never timeout",
            )
            assert.deepEqual(
              await Effect.runPromise(
                sql`SELECT revoked FROM capability_bindings WHERE run_id=${runId}`,
              ),
              [{ revoked: 0 }],
            )
            assert.notEqual((await Effect.runPromise(runs.read(runId)))?.state, "completed")
            await writeFile(
              `${root}/sql-fault.json`,
              JSON.stringify({
                runId,
                leaseStop: failure._tag,
                sshClosure: closure._tag,
                revoked: 0,
              }),
              { mode: 0o600 },
            )
            await Effect.runPromise(sql`DROP TRIGGER fail_owned_revocation`)
            expectedScopeFailure = true
          },
          async resume(prompt: string) {
            const previous = invocation
            permitted = Promise.withResolvers<void>()
            prepared = Promise.withResolvers<Invocation>()
            pending = pendingReceipt(
              control({ operation: "resume", nonce: previous.nonce, prompt }),
            )
            void pending.catch((error) => prepared.reject(error))
            await prepared.promise
            for (const key of [
              "session_id",
              "container_nonce",
              "channel",
              "deadline",
              "model",
              "effort",
            ] as const)
              assert.equal(invocation[key], previous[key])
            assert.notEqual(invocation.nonce, previous.nonce)
            assert.equal(
              (await control({ operation: "resume", nonce: previous.nonce, prompt })).status,
              409,
            )
            return { ...request(), prompt }
          },
        }
      }).pipe(Effect.provide(context), (effect) => Scope.provide(effect, scope)),
    )
  } catch (error) {
    await close()
    throw error
  }
}
