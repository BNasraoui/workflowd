import { expect, test } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { makeNativeCli, makeNativeExecutionStore } from "../../src/sandbox/native-execution"
import { makeNativeResultStore } from "../../src/sandbox/native-result"
import { makeCapabilityStore, capabilityDigest } from "../../src/capability-gateway/store"
import { seedCapabilityRun, transport } from "../capability-gateway/fixture"
import { disposableSsh } from "./fixtures/ssh.mjs"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { runLifetime } from "../../src/store/run-lifetime"
import { makeSandboxLeaseService } from "../../src/sandbox/lease"
import { makeSandboxGithub } from "../../src/sandbox/github"
import { sandboxGithubFixture } from "./harness"

for (const [entry, phase] of [
  ["cancel", "running"],
  ["scope finalizer", "running"],
  ["cancel", "acknowledgement"],
  ["scope finalizer", "acknowledgement"],
] as const) {
  test(`native ${entry} joins while real SQLite is held before ${phase}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "native-sql-held-"))
    await writeFile(
      join(root, "blocked.mjs"),
      `
      import {writeFileSync, watch} from 'node:fs';
      process.stdin.once('data', data => {
        const request=JSON.parse(data);
        const started=()=>process.stdout.write(JSON.stringify({event:'started',nonce:request.nonce,session:${phase === "acknowledgement" ? JSON.stringify("ses_new0123456789abcdefghijkl") : "request.session"}})+'\\n',()=>writeFileSync(${JSON.stringify(join(root, "started-sent"))},'sent'));
        if(${JSON.stringify(phase)}==='acknowledgement') {
          const watcher=watch(${JSON.stringify(root)}, (_,name)=>{if(name==='start'){watcher.close();started()}});
        } else started();
        writeFileSync(${JSON.stringify(join(root, "pid"))},String(process.pid));
      });
      setInterval(()=>{},1000);
    `,
    )
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { leases, sql } = yield* seedCapabilityRun(Date.now(), true)
          const capabilities = yield* makeCapabilityStore
          const job = yield* capabilities.challenge("run", transport, Date.now())
          yield* capabilities.bind(
            job,
            "jti",
            capabilityDigest("fixture"),
            Date.now() + 60000,
            Date.now(),
          )
          yield* leases.bind("run", 78, 1, transport)
          const store = yield* makeNativeExecutionStore
          const invocation = yield* store.reserve("run")
          yield* leases.attachSession("run", invocation.session_id)
          const scope = yield* Scope.make()
          const cli = yield* makeNativeCli({
            runId: "run",
            invocation,
            client: "opencode",
            provider: "fixture",
            transport,
            sshArguments: [fixtureExecutable("node"), join(root, "blocked.mjs")],
          }).pipe(Scope.provide(scope))
          const owned = yield* cli.spawn({
            runId: "run",
            directory: "/fixture",
            model: "fixture-model",
            prompt: "Once",
          })
          const waitFile = async (name: string) => {
            const deadline = Date.now() + 2000
            while (!(await Bun.file(join(root, name)).exists())) {
              if (Date.now() > deadline) throw new Error("Child barrier missing")
              await Bun.sleep(5)
            }
          }
          if (phase === "running")
            expect(
              (yield* Effect.promise(() => owned.events[Symbol.asyncIterator]().next())).value,
            ).toMatchObject({ type: "thread.started" })
          yield* Effect.promise(() => waitFile("pid"))
          const pid = Number(yield* Effect.promise(() => readFile(join(root, "pid"), "utf8")))
          const before = yield* store.read("run")
          const leaseBefore = yield* sql`SELECT session_id FROM sandbox_leases`
          const sessionsBefore = yield* sql`SELECT * FROM kernel_sessions`
          yield* Effect.promise(async () => {
            const entered = Promise.withResolvers<void>()
            const release = Promise.withResolvers<void>()
            const blocker = Effect.runPromise(
              sql.withTransaction(
                Effect.gen(function* () {
                  yield* sql`SELECT 1`
                  entered.resolve()
                  yield* Effect.promise(() => release.promise)
                }),
              ),
            )
            await entered.promise
            if (phase === "acknowledgement") {
              await writeFile(join(root, "start"), "start")
              await waitFile("started-sent")
              // Let the emitted started receipt reach the pump while SQLite remains held.
              await Bun.sleep(50)
            }
            const pending = Effect.runPromise(
              (entry === "cancel" ? owned.cancel : Scope.close(scope, Exit.void)).pipe(Effect.exit),
            )
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
              const settled = await Promise.race([
                pending,
                new Promise<null>((resolve) => {
                  timer = setTimeout(() => resolve(null), 5000)
                }),
              ])
              expect(settled?._tag).toBe("Failure")
              expect(() => process.kill(pid, 0)).toThrow()
              await Effect.runPromise(Scope.close(scope, Exit.void).pipe(Effect.exit))
            } finally {
              clearTimeout(timer)
              release.resolve()
              await blocker
              await pending
              await Effect.runPromise(Scope.close(scope, Exit.void).pipe(Effect.exit))
            }
          })
          // Interrupted queued transactions must not mutate authority after release.
          expect(yield* store.read("run")).toEqual(before)
          expect(yield* sql`SELECT session_id FROM sandbox_leases`).toEqual(leaseBefore)
          expect(yield* sql`SELECT * FROM kernel_sessions`).toEqual(sessionsBefore)
          expect(yield* sql`SELECT revoked FROM capability_bindings`).toEqual([{ revoked: 0 }])
          expect((yield* store.reserve("run").pipe(Effect.result))._tag).toBe("Failure")
        }).pipe(
          Effect.provide(AgentRunStoreLive),
          Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
          Effect.scoped,
        ),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 25000)
}

for (const entry of ["pump", "cancel", "scope finalizer", "lease stop"] as const) {
  test(`native ${entry} kills and joins a blocked process when SQL revocation fails`, async () => {
    const root = await mkdtemp(join(tmpdir(), "native-sql-fault-"))
    let pid: number | undefined
    await writeFile(
      join(root, "blocked.mjs"),
      `
      import {writeFileSync, watch} from 'node:fs';
      import {createInterface} from 'node:readline';
      const lines=createInterface({input:process.stdin});
      lines.once('line', line => {
        const request=JSON.parse(line);
        writeFileSync(${JSON.stringify(join(root, "pid"))}, String(process.pid));
        watch(${JSON.stringify(root)}, (_, name) => {
          if(name==='fault') process.stdout.write('not-json\\n');
        });
        console.log(JSON.stringify({event:'started',nonce:request.nonce,session:request.session}));
      });
      setInterval(() => {}, 1000);
    `,
    )
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { leases, sql } = yield* seedCapabilityRun(Date.now(), true)
          const capabilities = yield* makeCapabilityStore
          const job = yield* capabilities.challenge("run", transport, Date.now())
          yield* capabilities.bind(
            job,
            "jti",
            capabilityDigest("fixture"),
            Date.now() + 60000,
            Date.now(),
          )
          yield* leases.bind("run", 78, 1, transport)
          const store = yield* makeNativeExecutionStore
          const invocation = yield* store.reserve("run")
          const provider = new AbortController()
          const unlisten = runLifetime(sql).listen("run", () => provider.abort())
          let remoteStopped = false
          const result = yield* Effect.gen(function* () {
            const cli = yield* makeNativeCli({
              runId: "run",
              invocation,
              transport,
              sshArguments: [fixtureExecutable("node"), join(root, "blocked.mjs")],
            })
            const owned = yield* cli.spawn({
              runId: "run",
              directory: "/fixture",
              model: "fixture-model",
              prompt: "Once",
            })
            const events = owned.events[Symbol.asyncIterator]()
            expect((yield* Effect.promise(() => events.next())).value).toMatchObject({
              type: "thread.started",
            })
            pid = Number(yield* Effect.promise(() => readFile(join(root, "pid"), "utf8")))
            yield* sql`CREATE TRIGGER reject_revocation BEFORE UPDATE ON capability_bindings
            BEGIN SELECT RAISE(FAIL, 'injected durable revocation failure'); END`
            if (entry === "pump") {
              yield* Effect.promise(() => writeFile(join(root, "fault"), "fail"))
              yield* owned.exited
            } else if (entry === "cancel") yield* owned.cancel
            else if (entry === "lease stop") {
              const fixture = yield* Effect.promise(() =>
                sandboxGithubFixture({
                  repository: "fixture/repo",
                  repositoryId: 12,
                  installationId: 1,
                  workflowSha: "a".repeat(40),
                  appActorId: 56,
                  agentImage: "ghcr.io/bnasraoui/workflowd-agent-base@sha256:" + "b".repeat(64),
                }),
              )
              try {
                const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
                const service = yield* makeSandboxLeaseService(github, root, async (args) => {
                  expect(args.at(-1)).toBe("exec /usr/local/bin/runner-control native-stop")
                  process.kill(pid!, "SIGKILL")
                  await Effect.runPromise(owned.exited.pipe(Effect.result))
                  remoteStopped = true
                  return JSON.stringify({
                    nonce: invocation.nonce,
                    session: invocation.session_id,
                    stopped: true,
                  })
                })
                yield* service.stopNative("run")
              } finally {
                yield* Effect.promise(() => fixture.close())
              }
            }
          }).pipe(Effect.scoped, Effect.exit)
          unlisten()
          expect(result._tag).toBe("Failure")
          expect(provider.signal.aborted).toBe(true)
          if (entry === "lease stop") expect(remoteStopped).toBe(true)
          // Rollback is not a durable revocation. The reserved invocation remains
          // non-replayable, and local teardown must still have joined the child.
          expect((yield* store.read("run"))?.state).toBe("running")
          expect((yield* store.reserve("run").pipe(Effect.result))._tag).toBe("Failure")
          expect(() => process.kill(pid!, 0)).toThrow()
        }).pipe(
          Effect.provide(AgentRunStoreLive),
          Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
          Effect.scoped,
        ),
      )
    } finally {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          /* Already joined by the production path. */
        }
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            process.kill(pid, 0)
          } catch {
            break
          }
          await Bun.sleep(10)
        }
      }
      await rm(root, { recursive: true, force: true })
    }
  }, 10000)
}

for (const closure of [
  "clean",
  "nonzero exit",
  "trailing control",
  "diagnostic overflow",
  "forged advisory",
  "coalesced progress",
  "pause",
] as const) {
  test(`native controller requires a complete SSH closure before freezing: ${closure} (no container proof)`, async () => {
    const ssh = await disposableSsh((root) => `${fixtureExecutable("node")} ${root}/native.mjs`)
    await writeFile(
      join(ssh.root, "native.mjs"),
      `
    import { createInterface } from 'node:readline';
    import { appendFileSync } from 'node:fs';
    if(process.env.SSH_ORIGINAL_COMMAND !== 'exec /usr/local/bin/runner-control native-execute') process.exit(2);
    const lines=createInterface({input:process.stdin})[Symbol.asyncIterator]();
    const request=JSON.parse((await lines.next()).value);
    appendFileSync(${JSON.stringify(join(ssh.root, "launches"))},'launch\\n');
    const event=(event,extra={})=>console.log(JSON.stringify({event,nonce:request.nonce,session:request.session,...extra}));
    event('started');
    if (${JSON.stringify(closure)} === 'forged advisory') {
      event('model-output',{model:request.model,outputTokens:99999}); event('turn-ended');
    }
    const command=JSON.parse((await lines.next()).value);
    if(command.operation !== ${JSON.stringify(closure === "pause" ? "pause" : "finish")}) process.exit(3);
    event('closed',{outcome:${JSON.stringify(closure === "pause" ? "paused" : "completed")},stopped:true});
    if (${JSON.stringify(closure)} === 'trailing control') event('started');
    if (${JSON.stringify(closure)} === 'diagnostic overflow') process.stderr.write('x'.repeat(8192), () => process.exit(0));
    else process.exit(${closure === "nonzero exit" ? 1 : 0});
  `,
    )
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { leases } = yield* seedCapabilityRun(Date.now())
          const capabilities = yield* makeCapabilityStore
          const job = yield* capabilities.challenge("run", transport, Date.now())
          const binding = yield* capabilities.bind(
            job,
            "jti",
            capabilityDigest("fixture"),
            Date.now() + 60000,
            Date.now(),
          )
          yield* leases.bind("run", 78, 1, transport)
          const store = yield* makeNativeExecutionStore
          const invocation = yield* store.reserve("run")
          const results = yield* makeNativeResultStore
          yield* results.submit(binding, {
            revision: 0,
            completion: {
              branch: "native/free-choice",
              title: "Result",
              body: "Native result",
              commitMessage: "Native result",
            },
          })
          const execution = yield* Effect.gen(function* () {
            const cli = yield* makeNativeCli({
              runId: "run",
              invocation,
              transport,
              sshArguments: ssh.args,
            })
            const input = {
              runId: "run",
              directory: "/fixture",
              model: "fixture-model",
              prompt: "Synthetic task",
            }
            const process = yield* cli.spawn(input)
            const events = yield* Effect.promise(async () => {
              const values = []
              for await (const event of process.events) {
                values.push(event)
                if (event.type === "thread.started" && closure !== "forged advisory") {
                  // This test substitutes the gateway observation, not native files.
                  for (
                    let response = 0;
                    response < (closure === "coalesced progress" ? 32 : 1);
                    response++
                  )
                    await Effect.runPromise(
                      store.observeResponse("run", invocation.nonce, invocation.model, 3),
                    )
                  await Effect.runPromise(closure === "pause" ? process.pause! : process.finish!(1))
                }
              }
              return values
            })
            if (closure === "clean" || closure === "coalesced progress")
              expect(events).toEqual([
                { type: "thread.started", threadId: invocation.session_id },
                {
                  type: "provider.response",
                  model: "fixture-model",
                  outputTokens: closure === "clean" ? 3 : 96,
                },
                { type: "turn.completed", outputTokens: closure === "clean" ? 3 : 96 },
              ])
            expect(yield* process.exited).toEqual({
              exitCode: 0,
              stderr: "",
              ...(closure === "pause" ? { paused: true } : {}),
            })
            expect((yield* cli.spawn(input).pipe(Effect.result))._tag).toBe("Failure")
            if (closure === "pause") {
              expect(events).toEqual([
                { type: "thread.started", threadId: invocation.session_id },
                { type: "provider.response", model: "fixture-model", outputTokens: 3 },
              ])
              expect((yield* process.pause!.pipe(Effect.result))._tag).toBe("Failure")
              expect((yield* process.finish!(1).pipe(Effect.result))._tag).toBe("Failure")
            }
            yield* process.cancel
          }).pipe(Effect.scoped, Effect.exit)
          const completed = closure === "clean" || closure === "coalesced progress"
          expect(execution._tag).toBe(completed || closure === "pause" ? "Success" : "Failure")
          expect((yield* results.read("run"))?.frozen).toBe(completed ? 1 : 0)
          expect((yield* store.read("run"))?.state).toBe(
            completed ? "stopped" : closure === "pause" ? "paused" : "uncertain",
          )
          expect(yield* Effect.promise(() => Bun.file(join(ssh.root, "launches")).text())).toBe(
            "launch\n",
          )
        }).pipe(
          Effect.provide(AgentRunStoreLive),
          Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
          Effect.scoped,
        ),
      )
    } finally {
      await ssh.close()
    }
  }, 15000)
}

test("finalization intent and a later side effect cannot freeze an unjoined native invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-intent-unjoined-"))
  await writeFile(
    join(root, "unjoined.mjs"),
    `
    import {writeFileSync} from 'node:fs';
    import {createInterface} from 'node:readline';
    const lines=createInterface({input:process.stdin})[Symbol.asyncIterator]();
    const request=JSON.parse((await lines.next()).value);
    const event=(event,extra={})=>console.log(JSON.stringify({event,nonce:request.nonce,session:request.session,...extra}));
    writeFileSync(${JSON.stringify(join(root, "pid"))},String(process.pid));
    event('started');
    if(JSON.parse((await lines.next()).value).operation!=='finish')process.exit(2);
    writeFileSync(${JSON.stringify(join(root, "side-effect"))},'after intent');
    event('closed',{outcome:'completed',stopped:true});
    setInterval(()=>{},1000);
  `,
  )
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { leases } = yield* seedCapabilityRun(Date.now(), true)
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
        yield* results.submit(binding, {
          revision: 0,
          completion: {
            branch: "native/result",
            title: "Result",
            body: "Result",
            commitMessage: "Result",
          },
        })
        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void).pipe(Effect.ignore))
        const cli = yield* makeNativeCli({
          runId: "run",
          invocation,
          transport,
          sshArguments: [fixtureExecutable("node"), join(root, "unjoined.mjs")],
        }).pipe(Scope.provide(scope))
        const child = yield* cli.spawn({
          runId: "run",
          directory: "/fixture",
          model: invocation.model,
          prompt: "Once",
        })
        const events = child.events[Symbol.asyncIterator]()
        expect((yield* Effect.promise(() => events.next())).value).toMatchObject({
          type: "thread.started",
        })
        yield* native.observeResponse("run", invocation.nonce, invocation.model, 1)
        expect(
          yield* native.requestFinalization(binding, invocation.nonce, invocation.generation, 1),
        ).toBe(1)
        expect((yield* native.claimFinalization("run"))?.finalize_revision).toBe(1)
        yield* child.finish!(1)
        yield* Effect.promise(async () => {
          const deadline = Date.now() + 2000
          while (!(await Bun.file(join(root, "side-effect")).exists())) {
            if (Date.now() > deadline) throw new Error("Side effect barrier missing")
            await Bun.sleep(10)
          }
        })
        expect((yield* results.read("run"))?.frozen).toBe(0)
        expect((yield* native.read("run"))?.state).toBe("running")
        expect((yield* child.cancel.pipe(Effect.timeout("1 second"), Effect.result))._tag).toBe(
          "Failure",
        )
        expect((yield* results.read("run"))?.frozen).toBe(0)
        expect((yield* native.read("run"))?.state).toBe("uncertain")
        const pid = Number(yield* Effect.promise(() => readFile(join(root, "pid"), "utf8")))
        expect(() => process.kill(pid, 0)).toThrow()
        expect(
          yield* Effect.promise(() => Array.fromAsync({ [Symbol.asyncIterator]: () => events })),
        ).not.toContainEqual(expect.objectContaining({ type: "turn.completed" }))
        expect((yield* Scope.close(scope, Exit.void).pipe(Effect.exit))._tag).toBe("Failure")
      }).pipe(
        Effect.provide(AgentRunStoreLive),
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
        Effect.scoped,
      ),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const scenario of [
  "cancel before output",
  "lost acknowledgement",
  "foreign closure",
] as const) {
  test(`native SSH failure custody: ${scenario}`, async () => {
    const ssh = await disposableSsh((root) => `${fixtureExecutable("node")} ${root}/native.mjs`)
    await writeFile(
      join(ssh.root, "native.mjs"),
      `
      import {createInterface} from 'node:readline';
      import {appendFileSync} from 'node:fs';
      const lines=createInterface({input:process.stdin})[Symbol.asyncIterator]();
      const request=JSON.parse((await lines.next()).value);
      appendFileSync(${JSON.stringify(join(ssh.root, "launches"))},'launch\\n');
      const event=(event,extra={})=>console.log(JSON.stringify({event,nonce:request.nonce,session:request.session,...extra}));
      if(${JSON.stringify(scenario)}==='lost acknowledgement') process.exit(1);
      event('started');
      if(${JSON.stringify(scenario)}==='foreign closure') {event('closed',{outcome:'completed',stopped:true,nonce:'foreign'});process.exit(0)}
      const command=JSON.parse((await lines.next()).value);
      if(command.operation!=='cancel')process.exit(2);
      event('closed',{outcome:'cancelled',stopped:true});process.exit(0);
    `,
    )
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { leases, sql } = yield* seedCapabilityRun(Date.now(), true)
          const capabilities = yield* makeCapabilityStore
          const job = yield* capabilities.challenge("run", transport, Date.now())
          yield* capabilities.bind(
            job,
            "jti",
            capabilityDigest("fixture"),
            Date.now() + 60000,
            Date.now(),
          )
          yield* leases.bind("run", 78, 1, transport)
          const store = yield* makeNativeExecutionStore
          const invocation = yield* store.reserve("run")
          const result = yield* Effect.gen(function* () {
            const cli = yield* makeNativeCli({
              runId: "run",
              invocation,
              transport,
              sshArguments: ssh.args,
            })
            const process = yield* cli.spawn({
              runId: "run",
              directory: "/fixture",
              model: "fixture-model",
              prompt: "Once only",
            })
            if (scenario === "cancel before output") {
              const first = yield* Effect.promise(() =>
                process.events[Symbol.asyncIterator]().next(),
              )
              expect(first.value).toMatchObject({ type: "thread.started" })
              yield* process.cancel
            }
            yield* process.exited
          }).pipe(Effect.scoped, Effect.exit)
          expect(result._tag).toBe(scenario === "cancel before output" ? "Success" : "Failure")
          expect(yield* sql`SELECT revoked FROM capability_bindings`).toEqual([{ revoked: 1 }])
          expect((yield* store.read("run"))?.state).toBe(
            scenario === "cancel before output" ? "stopped" : "uncertain",
          )
          expect(yield* Effect.promise(() => Bun.file(join(ssh.root, "launches")).text())).toBe(
            "launch\n",
          )
        }).pipe(
          Effect.provide(AgentRunStoreLive),
          Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
          Effect.scoped,
        ),
      )
    } finally {
      await ssh.close()
    }
  }, 20000)
}
