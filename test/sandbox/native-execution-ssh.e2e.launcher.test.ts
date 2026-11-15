import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { readlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { makeNativeCli, makeNativeExecutionStore } from "../../src/sandbox/native-execution"
import { makeNativeResultStore } from "../../src/sandbox/native-result"
import { makeCapabilityStore, capabilityDigest } from "../../src/capability-gateway/store"
import { seedCapabilityRun, transport } from "../capability-gateway/fixture"
import { disposableSsh } from "./fixtures/ssh.mjs"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"

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

test("fixture namespace guard refuses missing, malformed and equal host namespace before SSH startup", async () => {
  const original = process.env.WORKFLOWD_FIXTURE_HOST_NETNS
  try {
    for (const value of [
      undefined,
      "net:[]",
      "net:[1]garbage",
      await readlink("/proc/self/ns/net"),
    ]) {
      if (value === undefined) delete process.env.WORKFLOWD_FIXTURE_HOST_NETNS
      else process.env.WORKFLOWD_FIXTURE_HOST_NETNS = value
      await expect(
        disposableSsh(() => {
          throw new Error("SSH configuration reached")
        }),
      ).rejects.toThrow("SSH fixture requires isolated netns")
    }
  } finally {
    if (original === undefined) delete process.env.WORKFLOWD_FIXTURE_HOST_NETNS
    else process.env.WORKFLOWD_FIXTURE_HOST_NETNS = original
  }
})
