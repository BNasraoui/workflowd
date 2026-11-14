import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { OpenCode } from "@opencode-ai/client/effect"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { makeSandboxDispatch } from "../../src/sandbox/dispatch"
import { SandboxPolicy } from "../../src/sandbox/config"
import { makeSandboxGithub } from "../../src/sandbox/github"
import { makeSandboxLeaseService } from "../../src/sandbox/lease"
import { makeNativeExecutionStore } from "../../src/sandbox/native-execution"
import { makeNativeResultStore } from "../../src/sandbox/native-result"
import { makeCapabilityStore, capabilityDigest } from "../../src/capability-gateway/store"
import { makeOpenCodeSdkClient, SdkOpenCodeAdapter } from "../../src/opencode/adapter"
import { nativeCommand } from "../../deploy/sandbox/native-command.mjs"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { seedCapabilityRun, transport } from "../capability-gateway/fixture"
import { sandboxGithubFixture } from "./harness"
import { disposableSsh } from "./fixtures/ssh.mjs"

for (const state of ["running", "paused", "uncertain stop"] as const) {
  test(`native coordinator startup cancels ${state} custody and settles once (SSH fixture)`, async () => {
    const ssh = await disposableSsh((root) => `${fixtureExecutable("node")} ${root}/recovery.mjs`)
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { sql, runs, leases } = yield* seedCapabilityRun(Date.now(), true)
          const policy = Schema.decodeUnknownSync(SandboxPolicy)(
            (yield* leases.read("run"))!.policy,
          )
          const fixture = yield* Effect.promise(() => sandboxGithubFixture(policy))
          try {
            const capabilities = yield* makeCapabilityStore
            const binding = yield* capabilities.bind(
              yield* capabilities.challenge("run", transport, Date.now()),
              "jti",
              capabilityDigest("fixture"),
              Date.now() + 60000,
              Date.now(),
            )
            yield* leases.bind("run", 78, 1, transport)
            const native = yield* makeNativeExecutionStore
            const results = yield* makeNativeResultStore
            const invocation = yield* native.reserve("run")
            yield* native.acknowledge("run", invocation.nonce)
            yield* results.submit(binding, {
              revision: 0,
              completion: {
                branch: "chosen/result",
                title: "Result",
                body: "Result",
                commitMessage: "Result",
              },
            })
            if (state === "paused") yield* native.closed("run", invocation.nonce, "paused", null)
            const directory = join(ssh.root, "run")
            yield* Effect.promise(() => mkdir(directory))
            const now = new Date().toISOString()
            yield* sql`INSERT INTO kernel_working_resources(resource_id,owning_host_id,absolute_path,kind,state,created_at,updated_at)
            VALUES('resource','fixture-controller',${directory},'workspace','reserved',${now},${now})`
            yield* sql`INSERT INTO kernel_sessions(session_id,provider_kind,provider_version,provider_id,server_id,owning_host_id,endpoint_alias,endpoint_identity,native_session_id,resource_id,state,revision,created_at,updated_at)
            VALUES('session','claude',1,'anthropic','fixture-ssh','fixture-controller','fixture','claude-cli://fixture-ssh',${invocation.session_id},'resource','active',1,${now},${now})`
            yield* sql`UPDATE kernel_agent_runs SET directory=${directory},session_id='session',resource_id='resource',native_session_id=${invocation.session_id},state='verified' WHERE run_id='run'`
            yield* Effect.promise(() =>
              writeFile(
                join(ssh.root, "recovery.mjs"),
                `
            import {appendFileSync,existsSync} from 'node:fs';
            const operation=process.env.SSH_ORIGINAL_COMMAND;
            if(operation==='exec /usr/local/bin/runner-control native-stop'){
              appendFileSync(${JSON.stringify(join(ssh.root, "stops"))},'stop\\n');
              if(${state === "uncertain stop"} && !existsSync(${JSON.stringify(join(ssh.root, "recovered"))})) process.exit(1);
              console.log(JSON.stringify({nonce:${JSON.stringify(invocation.nonce)},session:${JSON.stringify(invocation.session_id)},stopped:true}));
            } else if(operation==='exec /usr/local/bin/runner-control native-evidence'){
              console.log(JSON.stringify({nonce:${JSON.stringify(invocation.nonce)},session:${JSON.stringify(invocation.session_id)},pty:''}));
            } else process.exit(2);
          `,
              ),
            )
            const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
            const remote = yield* makeSandboxLeaseService(github, ssh.root, (args, input, signal) =>
              nativeCommand([...ssh.args, args.at(-1)!], input, { directory: ssh.root, signal }),
            )
            let released = 0
            const client = yield* OpenCode.make({ baseUrl: "http://127.0.0.1:1" }).pipe(
              Effect.provide(FetchHttpClient.layer),
            )
            const restart = () =>
              makeSandboxDispatch({
                policies: [policy],
                github,
                client,
                executor: new SdkOpenCodeAdapter(makeOpenCodeSdkClient(Effect.succeed(client))),
                executorId: "opencode:unused",
                endpointIdentity: "http://127.0.0.1:1",
                publicationContract: { reference: "fixture-only:worktree", receipt: "fixed-v1" },
                leases: {
                  ...remote,
                  release: (runId) =>
                    Effect.gen(function* () {
                      expect((yield* native.read(runId))?.state).toBe("stopped")
                      released++
                      yield* leases.beginRelease(runId)
                      for (const row of yield* leases.cleanupRuns()) {
                        yield* leases.cleanupState(row, "terminated")
                        yield* leases.finishCleanup(row, Effect.void, Effect.void)
                      }
                    }),
                },
              })
            let service = yield* restart()
            if (state === "uncertain stop") {
              expect(released).toBe(0)
              expect((yield* native.read("run"))?.state).toBe("uncertain")
              expect((yield* results.read("run"))?.frozen).toBe(0)
              expect((yield* runs.read("run"))?.state).toBe("verified")
              expect(yield* sql`SELECT id FROM resident_inbox`).toHaveLength(0)
              yield* Effect.promise(() =>
                writeFile(join(ssh.root, "recovered"), "owned stop now confirms"),
              )
              service = yield* restart()
            }
            expect((yield* runs.read("run"))?.state).toBe("operator_required")
            expect((yield* native.read("run"))?.state).toBe("stopped")
            expect((yield* results.read("run"))?.frozen).toBe(1)
            expect((yield* native.read("run"))?.outcome).toBe("cancelled")
            expect(
              (yield* remote.finishResult("run", "ignored model prose").pipe(Effect.result))._tag,
            ).toBe("Failure")
            expect(yield* sql`SELECT revoked FROM capability_bindings`).toEqual([{ revoked: 1 }])
            expect((yield* native.resume("run", invocation.nonce).pipe(Effect.result))._tag).toBe(
              "Failure",
            )
            expect(released).toBe(1)
            const mailbox = yield* sql`SELECT id,prompt FROM resident_inbox`
            expect(mailbox).toHaveLength(1)
            expect(mailbox[0]!.id).toBe("agent-run-end-run")
            expect(JSON.parse(String(mailbox[0]!.prompt))).toMatchObject({
              status: "operator_required",
              native_session_id: invocation.session_id,
            })
            yield* service.observe((yield* runs.read("run"))!)
            yield* restart()
            expect(yield* sql`SELECT id,prompt FROM resident_inbox`).toEqual(mailbox)
            expect(released).toBe(1)
            expect(
              (yield* Effect.promise(() => readFile(join(ssh.root, "stops"), "utf8")))
                .split("\n")
                .filter(Boolean).length,
            ).toBeGreaterThan(0)
          } finally {
            yield* Effect.promise(() => fixture.close())
          }
        }).pipe(
          Effect.provide(AgentRunStoreLive),
          Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
          Effect.scoped,
        ),
      )
    } finally {
      await ssh.close()
    }
  })
}
