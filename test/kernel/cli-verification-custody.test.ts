import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, Schema } from "effect"
import { routeRequest } from "../../src/http"
import {
  AgentRunIngress,
  AgentRunIngressLive,
  agentRunIdentifiers,
} from "../../src/kernel/agent-run-ingress"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import { makeCodexCli } from "../../src/kernel/codex-session"
import { makeClaudeDispatchCli } from "../../src/kernel/claude-dispatch"
import type { CliRunProcess } from "../../src/kernel/cli-process-contract"
import { at, defaultState, makeLayer, makeProvider, worktrees } from "./agent-run-ingress-harness"

const refusal = (response: Pick<Response, "json">) =>
  Effect.promise(() => response.json()).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.Struct({ reason: Schema.String, detail: Schema.String })),
    ),
  )

const manifestSchema = Schema.Struct({
  invocationId: Schema.NullOr(Schema.String),
  executionId: Schema.String,
  resultPath: Schema.String,
})
const fixture = async (
  kind: "codex" | "claude",
  stage: "dispatch" | "recovery",
  absent = false,
  verifyTimeoutMs = 10,
) => {
  const root = await mkdtemp(join(tmpdir(), "ccw2-verification-"))
  let child: ReturnType<typeof Bun.spawn> | undefined
  let description = ""
  const controls = {
    canStop: false,
    allowInspect: stage === "dispatch",
    launches: 0,
    stops: 0,
    acknowledgeOnly: false,
  }
  const started = Promise.withResolvers<void>()
  const observers: Array<Promise<void>> = []
  const alive = () => child !== undefined && child.exitCode === null && child.signalCode === null
  const terminate = async () => {
    if (child !== undefined) {
      if (alive()) child.kill("SIGKILL")
      await child.exited
    }
  }
  const appear = () => {
    child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
  }
  const binary = join(root, "native-fixture")
  await writeFile(binary, "#!/usr/bin/env bun\nconsole.log(JSON.stringify({loggedIn:true}));\n", {
    mode: 0o700,
  })
  const commands: ReadonlyArray<string>[] = []
  const native = (kind === "codex" ? makeCodexCli : makeClaudeDispatchCli)({
    binary,
    custodyRoot: root,
    pollIntervalMs: 2,
    commandTimeoutMs: 100,
    cancellationGraceMs: 10,
    observationTimeoutMs: 3000,
    runCommand: async (command) => {
      commands.push(command)
      if (command[0] === "systemd-run") {
        controls.launches += 1
        description = command.find((part) => part.startsWith("--description="))?.slice(14) ?? ""
        if (absent) return { exitCode: 1, stdout: "", stderr: "launch acknowledgement lost" }
        appear()
        return { exitCode: 0, stdout: "", stderr: "" }
      }
      if (command.includes("show-environment")) return { exitCode: 0, stdout: "", stderr: "" }
      if (command.includes("stop") || command.includes("kill")) {
        controls.stops += 1
        if (!controls.canStop)
          return { exitCode: 1, stdout: "", stderr: "isolated manager stop failure" }
        if (!controls.acknowledgeOnly) await terminate()
        return { exitCode: 0, stdout: "", stderr: "" }
      }
      if (!controls.allowInspect) throw new Error("isolated post-launch inspection failure")
      if (child === undefined)
        return { exitCode: 0, stdout: "LoadState=not-found\nActiveState=inactive\n", stderr: "" }
      return {
        exitCode: 0,
        stdout: `LoadState=loaded\nMainPID=${child.pid}\nInvocationID=verified-launch\nDescription=${description}\nActiveState=${alive() ? "active" : "inactive"}\nResult=success\n`,
        stderr: "",
      }
    },
  })
  if (native.ownership !== "transient-exec")
    throw new Error("fixture requires native transient custody")
  const watch = (process: CliRunProcess): CliRunProcess => ({
    ...process,
    exited: Effect.suspend(() => {
      const finished = Promise.withResolvers<void>()
      observers.push(finished.promise)
      return process.exited.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            finished.resolve()
          }),
        ),
      )
    }),
  })
  const cli = {
    ...native,
    spawn: (input: Parameters<typeof native.spawn>[0]) =>
      native.spawn(input).pipe(
        Effect.map(watch),
        Effect.tap(() =>
          Effect.sync(() => {
            started.resolve()
          }),
        ),
      ),
    attach: (input: Parameters<typeof native.attach>[0]) =>
      native
        .attach(input)
        .pipe(Effect.map((process) => (process === null ? null : watch(process)))),
  }
  const options = {
    routes: [],
    codexRoutes: kind === "codex" ? [{ name: "native", modelID: "native-model" }] : [],
    claudeRoutes: kind === "claude" ? [{ name: "native", modelID: "native-model" }] : [],
    repositories: [{ name: "workflowd", directory: root }],
    agent: "build",
    worktreeRoot: root,
    verifyTimeoutMs,
    verifyPollIntervalMs: 2,
    progressWindowMs: 1000,
    maxAttempts: 3,
    claudeHosts: [],
    identity: {
      owningHostId: "mint",
      providerId: "opencode-primary",
      serverId: "opencode-primary",
      endpointAlias: "local",
      endpointIdentity: "http://127.0.0.1:4096",
      providerVersion: 1,
    },
  }
  const input = {
    route: "native",
    repository: "workflowd",
    prompt: "inert fixture emits no output",
    idempotencyKey: "verification",
  }
  const id = agentRunIdentifiers({ ...input, parentSessionId: null, resumePrompt: null }).runId
  const request = (method: "POST" | "DELETE") =>
    Effect.gen(function* () {
      const ingress = yield* AgentRunIngress
      return yield* routeRequest(
        new Request(`http://fixture/workflows/agent-runs${method === "DELETE" ? `/${id}` : ""}`, {
          method,
          headers: { authorization: "Bearer secret", "content-type": "application/json" },
          ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
        }),
        { webhookSecret: "", now: at, agentRuns: { token: "secret", ...ingress } },
      )
    })
  const inspectManifest = Effect.promise(() =>
    readFile(join(root, id, "manifest.json"), "utf8"),
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(manifestSchema))))
  const layer = makeLayer(
    makeProvider(defaultState()),
    worktrees([]),
    kind === "codex" ? cli : undefined,
    options,
    kind === "claude" ? cli : undefined,
  )
  const verify = Effect.gen(function* () {
    const response = yield* request("POST")
    if (stage === "recovery") {
      expect(response.status).toBe(500)
      controls.allowInspect = true
      yield* Effect.void.pipe(Effect.provide(AgentRunIngressLive(options)))
    } else {
      expect(response.status).toBe(409)
      expect((yield* refusal(response.clone())).reason).toBe("no_first_token")
    }
    return response
  })
  const close = async () => {
    await terminate()
    await Promise.all(observers)
    await rm(root, { recursive: true, force: true })
  }
  return {
    controls,
    commands,
    alive,
    terminate,
    appear,
    started,
    options,
    layer,
    id,
    request,
    verify,
    inspectManifest,
    close,
  }
}

for (const kind of ["codex", "claude"] as const) {
  for (const stage of ["dispatch", "recovery"] as const) {
    test(`${kind} ${stage} verification cleanup failure retains cancellable same-execution custody`, async () => {
      const f = await fixture(kind, stage)
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const store = yield* AgentRunStore
            const response = yield* f.verify
            const row = yield* store.read(f.id)
            expect(row?.state).toBe("operator_required")
            expect(row?.diagnostic).toContain("isolated manager stop failure")
            if (stage === "dispatch")
              expect((yield* refusal(response)).detail).toContain("isolated manager stop failure")
            const before = yield* f.inspectManifest
            expect(before.invocationId).toBe("verified-launch")
            expect(f.alive()).toBe(true)
            expect((yield* f.request("POST")).status).toBe(409)
            expect(f.controls.launches).toBe(1)
            const unsuccessful = yield* f.request("DELETE")
            expect(unsuccessful.status).toBe(409)
            expect((yield* refusal(unsuccessful)).detail).toContain("isolated manager stop failure")
            expect((yield* store.read(f.id))?.diagnostic).toContain("isolated manager stop failure")
            f.controls.canStop = true
            expect((yield* f.request("DELETE")).status).toBe(204)
            expect((yield* store.read(f.id))?.state).toBe("cancelled")
            expect(f.alive()).toBe(false)
            expect(yield* f.inspectManifest).toEqual(before)
            expect(f.controls.launches).toBe(1)
            expect(
              f.commands
                .filter((command) => command.includes("stop"))
                .every((command) => command.at(-1) === before.executionId),
            ).toBe(true)
          }).pipe(Effect.provide(f.layer)),
        )
      } finally {
        await f.close()
      }
    })

    test(`${kind} ${stage} retains custody when stop/kill acknowledge without terminating`, async () => {
      const f = await fixture(kind, stage)
      f.controls.canStop = true
      f.controls.acknowledgeOnly = true
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const store = yield* AgentRunStore
            yield* f.verify
            expect((yield* store.read(f.id))?.state).toBe("operator_required")
            expect((yield* store.read(f.id))?.diagnostic).toContain("kill codex transient unit")
            expect(f.alive()).toBe(true)
            f.controls.acknowledgeOnly = false
            expect((yield* f.request("DELETE")).status).toBe(204)
            expect((yield* store.read(f.id))?.state).toBe("cancelled")
            expect(f.alive()).toBe(false)
            expect(f.controls.launches).toBe(1)
          }).pipe(Effect.provide(f.layer)),
        )
      } finally {
        await f.close()
      }
    })

    test(`${kind} ${stage} verification timeout records failed only after confirmed native stop`, async () => {
      const f = await fixture(kind, stage)
      f.controls.canStop = true
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const store = yield* AgentRunStore
            yield* f.verify
            expect((yield* store.read(f.id))?.state).toBe("failed")
            expect(f.alive()).toBe(false)
            expect(f.controls.stops).toBeGreaterThan(0)
            expect((yield* f.inspectManifest).invocationId).toBe("verified-launch")
            expect((yield* f.request("POST")).status).toBe(409)
            expect(f.controls.launches).toBe(1)
          }).pipe(Effect.provide(f.layer)),
        )
      } finally {
        await f.close()
      }
    })

    test(`${kind} ${stage} absent unconfirmed cancellation refuses with operator custody, then cancels a late execution`, async () => {
      const f = await fixture(kind, "dispatch", true)
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const store = yield* AgentRunStore
            expect((yield* f.request("POST")).status).toBe(500)
            if (stage === "recovery")
              yield* Effect.void.pipe(Effect.provide(AgentRunIngressLive(f.options)))
            const response = yield* f.request("DELETE")
            expect(response.status).toBe(409)
            const rejection = yield* refusal(response)
            expect(rejection.reason).toBe("run_conflict")
            expect(rejection.detail).toContain("launch remains unconfirmed")
            expect((yield* store.read(f.id))?.state).toBe("operator_required")
            expect((yield* store.read(f.id))?.diagnostic).toContain("launch remains unconfirmed")
            expect((yield* f.inspectManifest).invocationId).toBeNull()
            expect((yield* f.request("POST")).status).toBe(409)
            f.appear()
            f.controls.canStop = true
            expect((yield* f.request("DELETE")).status).toBe(204)
            expect((yield* store.read(f.id))?.state).toBe("cancelled")
            expect((yield* f.inspectManifest).invocationId).toBe("verified-launch")
            expect(f.alive()).toBe(false)
            expect(f.controls.launches).toBe(1)
          }).pipe(Effect.provide(f.layer)),
        )
      } finally {
        await f.close()
      }
    })
  }

  test(`${kind} retains operator custody after failed cleanup and can settle a later native terminal result`, async () => {
    const f = await fixture(kind, "dispatch")
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* AgentRunStore
          yield* f.verify
          expect((yield* store.read(f.id))?.state).toBe("operator_required")
          const manifest = yield* f.inspectManifest
          yield* Effect.promise(async () => {
            await writeFile(manifest.resultPath, '{"version":1,"exitCode":0}\n')
            await f.terminate()
          })
          const stops = f.controls.stops
          expect((yield* f.request("DELETE")).status).toBe(204)
          expect((yield* store.read(f.id))?.state).toBe("cancelled")
          expect(f.controls.stops).toBe(stops)
          expect(f.controls.launches).toBe(1)
          expect(yield* f.inspectManifest).toEqual(manifest)
        }).pipe(Effect.provide(f.layer)),
      )
    } finally {
      await f.close()
    }
  })

  test(`${kind} verification interruption retains native custody and duplicate fencing until explicit cancellation`, async () => {
    const f = await fixture(kind, "dispatch", false, 1000)
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* AgentRunStore
          const pending = yield* f.request("POST").pipe(Effect.forkChild)
          yield* Effect.promise(() => f.started.promise)
          yield* Fiber.interrupt(pending)
          expect((yield* store.read(f.id))?.state).toBe("spawning")
          expect((yield* f.inspectManifest).invocationId).toBe("verified-launch")
          expect(f.alive()).toBe(true)
          expect((yield* f.request("POST")).status).toBe(409)
          f.controls.canStop = true
          expect((yield* f.request("DELETE")).status).toBe(204)
          expect((yield* store.read(f.id))?.state).toBe("cancelled")
          expect(f.alive()).toBe(false)
          expect(f.controls.launches).toBe(1)
        }).pipe(Effect.provide(f.layer)),
      )
    } finally {
      await f.close()
    }
  })
}
