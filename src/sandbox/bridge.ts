import { assertBridgeBinding } from "./binding"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { SandboxTransport, sandboxSshArguments } from "./transport"

const frameLimit = 1024 * 1024
const timeoutMs = 5 * 60 * 1000
// container-use v0.4.2, obtained from its checksum-verified Linux amd64 release.
const manifestHash = "64d460e7eb2964c9995b03c3aa16ffcad89d4067fe6a903656843a651d5b1fdf"
const Id = Schema.Union([Schema.String, Schema.Number])
const Frame = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(Id),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Json),
  result: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(Schema.Json),
})
const Tool = Schema.Struct({ name: Schema.String })
const Catalog = Schema.Struct({ tools: Schema.Array(Schema.Json) })
const Call = Schema.Struct({
  name: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Json),
})
const Output = Schema.Struct({
  content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
  isError: Schema.optionalKey(Schema.Boolean),
})

async function* frames(reader: {
  read(): Promise<
    { done: true; value?: Uint8Array | undefined } | { done: false; value: Uint8Array }
  >
}) {
  let pending = Buffer.alloc(0)
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    pending = Buffer.concat([pending, next.value])
    for (let end = pending.indexOf(10); end !== -1; end = pending.indexOf(10)) {
      if (end > frameLimit) throw new Error("Sandbox MCP frame exceeds 1 MiB")
      const value: unknown = JSON.parse(pending.subarray(0, end).toString("utf8"))
      pending = pending.subarray(end + 1)
      yield Schema.decodeUnknownSync(Frame)(value)
    }
    if (pending.length > frameLimit) throw new Error("Sandbox MCP frame exceeds 1 MiB")
  }
  if (pending.length !== 0) throw new Error("Incomplete sandbox MCP frame")
}

async function drainDiagnostics(stream: ReadableStream<Uint8Array>) {
  let bytes = 0
  for await (const chunk of stream) {
    bytes += chunk.length
    if (bytes > frameLimit) throw new Error("Sandbox SSH diagnostics exceed 1 MiB")
  }
}

export async function compileSandboxBridge(outfile: string) {
  const result = await Bun.build({ entrypoints: [import.meta.path], compile: { outfile } })
  if (!result.success) throw new Error("Could not compile sandbox MCP bridge")
}

export async function runSandboxBridge(
  transport: SandboxTransport,
  incoming: ReadableStream<Uint8Array>,
  send: (frame: string) => Promise<void>,
  bindingFile?: string,
) {
  if (bindingFile !== undefined) await assertBridgeBinding(bindingFile, transport)
  const child = Bun.spawn([...sandboxSshArguments(transport)], {
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const input = incoming.getReader()
  const replies = frames(child.stdout.getReader())
  const stop = () => {
    child.kill()
  }
  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
  const monitor = async () => {
    await drainDiagnostics(child.stderr)
    throw new Error("Sandbox SSH connection closed")
  }
  const forward = async () => {
    let initialized = false
    let allowed = new Set<string>()
    for await (const frame of frames(input)) {
      if (bindingFile !== undefined) await assertBridgeBinding(bindingFile, transport)
      if (frame.method === "notifications/initialized" && initialized && frame.id === undefined) {
        child.stdin.write(JSON.stringify(frame) + "\n")
        await child.stdin.flush()
        continue
      }
      if (
        frame.id === undefined ||
        frame.method === undefined ||
        frame.result !== undefined ||
        frame.error !== undefined
      ) {
        throw new Error("Unexpected sandbox client frame")
      }
      let request = frame
      switch (frame.method) {
        case "initialize":
          if (initialized) throw new Error("Sandbox MCP already initialized")
          request = {
            ...frame,
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "workflowd-sandbox", version: "1" },
            },
          }
          break
        case "tools/list":
          if (!initialized) throw new Error("Sandbox MCP is not initialized")
          request = { ...frame, params: {} }
          break
        case "tools/call": {
          const call = Schema.decodeUnknownSync(Call)(frame.params)
          if (
            !allowed.has(call.name) ||
            call.arguments.environment_source !== transport.repositoryPath
          ) {
            throw new Error("Sandbox tool or repository is not allowed")
          }
          break
        }
        default:
          throw new Error("Sandbox MCP method is not allowed")
      }
      const timer = setTimeout(() => child.kill(), timeoutMs)
      try {
        child.stdin.write(JSON.stringify(request) + "\n")
        await child.stdin.flush()
        const next = await replies.next()
        if (
          next.done ||
          next.value.method !== undefined ||
          next.value.id !== frame.id ||
          next.value.error !== undefined
        ) {
          throw new Error("Unexpected sandbox server frame")
        }
        let result = next.value.result
        if (frame.method === "initialize") {
          initialized = true
          result = {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "workflowd-container-use", version: "0.4.2" },
          }
        } else if (frame.method === "tools/list") {
          const catalog = Schema.decodeUnknownSync(Catalog)(result)
          if (
            createHash("sha256").update(JSON.stringify(catalog.tools)).digest("hex") !==
            manifestHash
          ) {
            throw new Error("Sandbox tool manifest differs from pinned container-use")
          }
          allowed = new Set(catalog.tools.map((tool) => Schema.decodeUnknownSync(Tool)(tool).name))
          result = catalog
        } else {
          result = Schema.decodeUnknownSync(Output)(result)
        }
        if (bindingFile !== undefined) await assertBridgeBinding(bindingFile, transport)
        await send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }) + "\n")
      } finally {
        clearTimeout(timer)
      }
    }
  }
  const forwarding = forward()
  const diagnostics = monitor()
  try {
    await Promise.race([forwarding, diagnostics])
  } finally {
    child.kill()
    await input.cancel()
    await child.exited
    await Promise.allSettled([forwarding, diagnostics])
    process.removeListener("SIGTERM", stop)
    process.removeListener("SIGINT", stop)
  }
}

if (import.meta.main) {
  const run = async () => {
    const file = process.argv[2]
    if (file === undefined) throw new Error("Sandbox transport file is required")
    const input: unknown = await Bun.file(file).json()
    await runSandboxBridge(
      Schema.decodeUnknownSync(SandboxTransport)(input),
      Bun.stdin.stream(),
      async (frame) => {
        await Bun.write(Bun.stdout, frame)
      },
      process.argv[3],
    )
  }
  await run().catch(() => {
    process.stderr.write("Sandbox MCP bridge refused or lost its transport\n")
    process.exitCode = 1
  })
}
