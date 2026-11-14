import { Effect, Scope } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import type { CapabilityGateway } from "../capability-gateway/service"
import type { CapabilityBinding } from "../capability-gateway/store"
import { sandboxSshArguments, type SandboxTransport } from "./transport"
import { ownedPromise } from "../capability-gateway/owned"
import { capabilityHttpServer } from "../capability-gateway/http"

/** A private per-binding Unix backend keeps the immutable subject out of request headers. */
export const makeCapabilityTransport = (
  gateway: typeof CapabilityGateway.Service,
  nodeBinary: string,
  root: string,
  sshArguments = sandboxSshArguments,
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const live = new Map<string, () => Promise<void>>()
    const disconnect = Effect.fn("CapabilityTransport.disconnect")((runId: string) =>
      Effect.tryPromise(async () => {
        await live.get(runId)?.()
      }),
    )
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise(() => Promise.all([...live.values()].map((close) => close()))).pipe(
        Effect.orDie,
      ),
    )
    const connect = Effect.fn("CapabilityTransport.connect")(
      (
        binding: CapabilityBinding,
        transport: SandboxTransport,
        releaseBootstrap?: () => Promise<void>,
      ) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const owned = yield* restore(
              ownedPromise(async (signal) => {
                if (live.has(binding.runId)) throw new Error("capability transport already bound")
                const directory = await mkdtemp(join(root, "gateway-"))
                let stopServer = async () => {}
                let stopChild = async () => {}
                let closing: Promise<void> | undefined
                const close = () =>
                  (closing ??= (async () => {
                    try {
                      await stopChild()
                    } finally {
                      try {
                        await stopServer()
                      } finally {
                        try {
                          await rm(directory, { recursive: true, force: true })
                        } finally {
                          await releaseBootstrap?.()
                          if (live.get(binding.runId) === close) live.delete(binding.runId)
                        }
                      }
                    }
                  })())
                try {
                  const backend = join(directory, "http.sock")
                  if (backend.length > 100) throw new Error("capability socket path too long")
                  signal.throwIfAborted()
                  const { server, close: closeServer } = capabilityHttpServer((request) =>
                    Effect.runPromise(gateway.handle(binding, request), { signal: request.signal }),
                  )
                  stopServer = closeServer
                  await new Promise<void>((resolve, reject) => {
                    server.once("error", reject)
                    server.listen(backend, resolve)
                  })
                  const ssh = [
                    ...sshArguments(transport).slice(0, -1),
                    "exec /usr/local/bin/runner-control capabilities",
                  ]
                  const child = Bun.spawn(
                    [
                      nodeBinary,
                      join(import.meta.dir, "../../deploy/sandbox/capability-relay.mjs"),
                      "controller",
                    ],
                    {
                      env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
                      stdin: new Blob([JSON.stringify({ ssh, backend })]),
                      stdout: "pipe",
                      stderr: "ignore",
                    },
                  )
                  stopChild = async () => {
                    child.kill("SIGKILL")
                    await child.exited
                  }
                  live.set(binding.runId, close)
                  const stop = () => {
                    child.kill("SIGKILL")
                  }
                  const timer = setTimeout(stop, 15000)
                  signal.addEventListener("abort", stop, { once: true })
                  try {
                    const ready = await child.stdout.getReader().read()
                    signal.throwIfAborted()
                    if (ready.done || Buffer.from(ready.value).toString() !== "ready\n")
                      throw new Error("capability transport unavailable")
                    return { child, close }
                  } catch (error) {
                    await close()
                    throw error
                  } finally {
                    clearTimeout(timer)
                    signal.removeEventListener("abort", stop)
                  }
                } catch (error) {
                  await close()
                  throw error
                }
              }),
            )
            yield* Effect.tryPromise(() => owned.child.exited).pipe(
              Effect.andThen(gateway.revoke(binding.runId)),
              Effect.ensuring(Effect.tryPromise(owned.close).pipe(Effect.orDie)),
              Effect.forkIn(scope),
            )
          }),
        ),
    )
    return { connect, disconnect }
  })
