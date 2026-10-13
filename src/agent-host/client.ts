import { connect } from "node:net"
import { Effect, Schema } from "effect"
import type { CliPort } from "../kernel/cli-process-contract"
import { WorkspaceError } from "../workspace/errors"
import {
  CredentialResponse,
  credentialReason,
  credentialRefusal,
  type CredentialClient,
} from "./protocol"

export function acquireCredentialAdmission(
  path: string,
  client: CredentialClient,
): Promise<() => Promise<void>> {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    let admitted = false
    const fail = (cause: unknown = new Error("host connection closed before admission")) => {
      socket.destroy()
      reject(
        Object.assign(credentialRefusal(client, "credential_host_unreachable_or_timed_out"), {
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
      )
    }
    socket.setTimeout(15000, () => fail(new Error("credential host timed out after 15000ms")))
    socket.on("error", fail)
    socket.once("connect", () =>
      socket.write(JSON.stringify({ operation: "checkCredentials", client }) + "\n"),
    )
    let data = ""
    socket.on("data", (chunk) => {
      if (admitted) return
      data += chunk.toString("utf8")
      if (data.length > 1024) {
        fail()
        return
      }
      if (!data.includes("\n")) return
      try {
        const response = Schema.decodeUnknownSync(CredentialResponse)(JSON.parse(data))
        if (!response.admitted) {
          socket.destroy()
          reject(credentialRefusal(client, response.reason))
          return
        }
        admitted = true
        socket.setTimeout(0)
        resolve(
          () =>
            new Promise<void>((done) => {
              if (socket.destroyed) {
                done()
                return
              }
              socket.once("close", done)
              socket.end()
            }),
        )
      } catch (cause) {
        fail(cause)
      }
    })
    socket.on("close", () => {
      if (!admitted) fail()
    })
  })
}

export function withCredentialAdmission<A, E, R>(
  socket: string | undefined,
  client: CredentialClient,
  effect: Effect.Effect<A, E, R>,
) {
  if (socket === undefined) return effect
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => acquireCredentialAdmission(socket, client),
      catch: (error) =>
        Object.assign(
          credentialRefusal(
            client,
            credentialReason(error) ?? "credential_host_unreachable_or_timed_out",
          ),
          {
            detail:
              typeof error === "object" && error !== null && "detail" in error
                ? String(error.detail)
                : String(error),
          },
        ),
    }),
    () => effect,
    (release) => Effect.tryPromise(release).pipe(Effect.orDie),
  )
}

export function guardCliCredentials<T extends CliPort>(
  cli: T,
  socket: string | undefined,
  client: "codex" | "claude",
): Omit<T, "preflight" | "spawn"> & Pick<CliPort, "preflight" | "spawn"> {
  return {
    ...cli,
    preflight: withCredentialAdmission(socket, client, cli.preflight).pipe(
      Effect.mapError((error) =>
        "reason" in error ? { kind: error.reason, detail: error.detail } : error,
      ),
    ),
    spawn: (input) =>
      withCredentialAdmission(socket, client, cli.spawn(input)).pipe(
        Effect.mapError((error) =>
          "client" in error
            ? new WorkspaceError({ operation: "credential admission", cause: error })
            : error,
        ),
      ),
  }
}

export async function withCredentialAdmissionPromise<A>(
  socket: string | undefined,
  client: CredentialClient,
  run: () => Promise<A>,
) {
  if (socket === undefined) return run()
  const release = await acquireCredentialAdmission(socket, client)
  try {
    return await run()
  } finally {
    await release()
  }
}

/** One request performs one bounded operation; a disconnect never cancels owned work. */
function requestAgentHostResponse(path: string, request: import("./protocol").HostRequest) {
  return new Promise<Extract<typeof HostResponse.Type, { admitted: true }>>((resolve, reject) => {
    const socket = connect(path)
    let data = ""
    let settled = false
    const fail = (error: unknown) => {
      settled = true
      socket.destroy()
      reject(normalizeError(error))
    }
    socket.setTimeout(15000, () => fail(new Error("agent host timed out; custody retained")))
    socket.on("error", fail)
    socket.on("close", () => {
      if (!settled) fail(new Error("agent host disconnected; custody retained"))
    })
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"))
    socket.on("data", (chunk) => {
      data += chunk.toString()
      if (Buffer.byteLength(data) > 100000) {
        fail(new Error("oversized host response"))
        return
      }
      if (!data.includes("\n")) return
      try {
        const response = Schema.decodeUnknownSync(HostResponse)(JSON.parse(data))
        if (!response.admitted) {
          const reason = credentialReason({ reason: response.reason })
          throw reason
            ? credentialRefusal(
                request.operation === "start" && request.profile.startsWith("codex")
                  ? "codex"
                  : "claude",
                reason,
              )
            : new Error(`${response.reason}${response.detail ? `: ${response.detail}` : ""}`)
        }
        settled = true
        socket.destroy()
        resolve(response)
      } catch (error) {
        fail(error)
      }
    })
  })
}

import { HostResponse, type OwnedProcess, type HostStart } from "./protocol"
import type { CliEvent, CliRunProcess } from "../kernel/cli-process-contract"
import { normalizeError } from "../errors"

export async function inspectAgentHost(socket: string, runId: string) {
  const response = await requestAgentHost(socket, { operation: "inspect", runId })
  if (Buffer.isBuffer(response)) throw new Error("unexpected host exchange")
  return response
}

async function hostBytes(
  socket: string,
  process: OwnedProcess,
  file: "events" | "stderr" | "result",
  offset: number,
) {
  const response = await requestAgentHost(socket, {
    operation: "exchange",
    runId: process.runId,
    launchId: process.launchId,
    file,
    offset,
  })
  if (!Buffer.isBuffer(response)) throw new Error("unexpected host observation")
  return response
}

export async function startAgentHost(socket: string, input: Omit<HostStart, "operation">) {
  const response = await requestAgentHost(socket, { operation: "start", ...input })
  if (!response || Buffer.isBuffer(response)) throw new Error("host did not return custody")
  return response
}

export function observeAgentHost(
  socket: string,
  process: OwnedProcess,
  parse: (line: string) => CliEvent,
): CliRunProcess {
  const observe = async () => {
    const current = await inspectAgentHost(socket, process.runId)
    if (
      !current ||
      current.launchId !== process.launchId ||
      (process.invocationId !== null && current.invocationId !== process.invocationId)
    )
      throw new Error("host custody changed")
    return current
  }
  const failure = (cause: unknown) =>
    new WorkspaceError({ operation: "native host process", cause: normalizeError(cause) })
  return {
    executionId: process.unit,
    events: {
      async *[Symbol.asyncIterator]() {
        let offset = 0
        let buffered = ""
        const decoder = new TextDecoder()
        for (;;) {
          const current = await observe()
          const bytes = await hostBytes(socket, process, "events", offset)
          offset += bytes.length
          buffered += decoder.decode(bytes, { stream: true })
          let end: number
          while ((end = buffered.indexOf("\n")) >= 0) {
            yield parse(buffered.slice(0, end))
            buffered = buffered.slice(end + 1)
          }
          if (buffered.length > 10 * 1024 * 1024) throw new Error("host event exceeds output limit")
          if (!current.active && bytes.length === 0) {
            if (buffered) yield parse(buffered)
            return
          }
          if (bytes.length === 0) await new Promise((resolve) => setTimeout(resolve, 100))
        }
      },
    },
    exited: Effect.tryPromise({
      try: async (signal) => {
        for (;;) {
          signal.throwIfAborted()
          const current = await observe()
          if (!current.active)
            return {
              exitCode: current.exitCode ?? -1,
              stderr: (await hostBytes(socket, process, "stderr", 0)).toString(),
            }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      },
      catch: failure,
    }),
    cancel: Effect.tryPromise({
      try: async () => {
        await requestAgentHost(socket, {
          operation: "stop",
          runId: process.runId,
          launchId: process.launchId,
        })
      },
      catch: failure,
    }),
  }
}

export function makeHostCli(
  socket: string,
  client: "codex" | "claude",
  parse: (line: string) => CliEvent,
): Extract<CliPort, { ownership: "transient-exec" }> {
  const failure = (cause: unknown) =>
    new WorkspaceError({ operation: "native host launch", cause: normalizeError(cause) })
  return {
    ownership: "transient-exec",
    preflight: Effect.tryPromise({
      try: async () => {
        // The host chooses the configured workspace for preflight.
        const process = await startAgentHost(socket, {
          runId: `preflight-${crypto.randomUUID()}`,
          profile: `${client}-preflight`,
          timeoutMs: 10000,
          directory: "",
          prompt: "",
          model: null,
        })
        const result = await Effect.runPromise(observeAgentHost(socket, process, parse).exited)
        if (result.exitCode !== 0) throw new Error("native authentication preflight failed")
      },
      catch: (cause) => ({
        kind: credentialReason(cause) ?? ("cli_unusable" as const),
        detail: normalizeError(cause).message,
      }),
    }),
    spawn: (input) =>
      Effect.tryPromise({
        try: async () => {
          if (input.sandboxBindingFile !== undefined)
            throw new Error("host sandbox relay is not provisioned")
          const process = await startAgentHost(socket, {
            runId: input.runId,
            profile: client,
            directory: input.directory,
            prompt: input.prompt,
            model: input.model,
            ...(input.effort === undefined ? {} : { effort: input.effort }),
            ...(input.provider == null ? {} : { provider: input.provider }),
          })
          input.onSpawn?.(process.pid)
          return observeAgentHost(socket, process, parse)
        },
        catch: failure,
      }),
    attach: (input) =>
      Effect.tryPromise({
        try: async () => {
          const process = await inspectAgentHost(socket, input.runId)
          return process === null ? null : observeAgentHost(socket, process, parse)
        },
        catch: failure,
      }),
  }
}

export async function readAgentHostOutput(
  socket: string,
  process: OwnedProcess,
  limit = 10 * 1024 * 1024,
  signal?: AbortSignal,
) {
  for (;;) {
    signal?.throwIfAborted()
    const current = await inspectAgentHost(socket, process.runId)
    if (
      !current ||
      current.launchId !== process.launchId ||
      current.invocationId !== process.invocationId
    )
      throw new Error("host custody changed")
    if (!current.active) {
      if (current.exitCode !== 0)
        throw new Error("native host process failed or did not finish within its deadline")
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const chunks: Buffer[] = []
  let size = 0
  for (;;) {
    const bytes = await hostBytes(socket, process, "events", size)
    if (!bytes.length) return Buffer.concat(chunks).toString()
    size += bytes.length
    if (size > limit) throw new Error("native host output exceeds limit")
    chunks.push(bytes)
  }
}

export function connectAgentHost(
  path: string,
  process: OwnedProcess,
  receive: (line: string) => void,
  disconnected: () => void,
) {
  return new Promise<{ send: (line: string) => void; close: () => void }>((resolve, reject) => {
    const socket = connect(path)
    let admitted = false
    let detached = false
    let data = ""
    const fail = (cause: unknown) => {
      socket.destroy()
      reject(normalizeError(cause))
    }
    socket.setTimeout(15000, () => fail(new Error("host relay timed out")))
    socket.on("error", fail)
    socket.on("connect", () =>
      socket.write(
        JSON.stringify({ operation: "connect", runId: process.runId, launchId: process.launchId }) +
          "\n",
      ),
    )
    socket.on("close", () => {
      if (!admitted) reject(new Error("host relay closed before attachment"))
      else if (!detached) disconnected()
    })
    socket.on("data", (chunk) => {
      data += chunk.toString()
      if (Buffer.byteLength(data) > 2000000) {
        fail(new Error("host relay frame too large"))
        return
      }
      let end: number
      while ((end = data.indexOf("\n")) >= 0) {
        const line = data.slice(0, end)
        data = data.slice(end + 1)
        try {
          if (admitted) receive(line)
          else {
            const reply = Schema.decodeUnknownSync(HostResponse)(JSON.parse(line))
            if (
              !reply.admitted ||
              !("process" in reply) ||
              reply.process?.launchId !== process.launchId
            )
              throw new Error(
                !reply.admitted && reply.detail
                  ? `host relay refused custody: ${reply.detail}`
                  : "host relay refused custody",
              )
            admitted = true
            socket.setTimeout(0)
            resolve({
              send: (frame) => {
                if (socket.destroyed) throw new Error("host relay disconnected")
                socket.write(frame.trimEnd() + "\n")
              },
              close: () => {
                detached = true
                socket.destroy()
              },
            })
          }
        } catch (error) {
          fail(error)
        }
      }
    })
  })
}

export async function requestAgentHost(path: string, request: import("./protocol").HostRequest) {
  const response = await requestAgentHostResponse(path, request)
  if ("processes" in response) throw new Error("unexpected host list response")
  return "process" in response ? response.process : Buffer.from(response.bytes, "base64")
}

export async function listAgentHost(path: string) {
  const processes: OwnedProcess[] = []
  let cursor: number | null = 0
  while (cursor !== null) {
    const response = await requestAgentHostResponse(path, { operation: "listOwned", cursor })
    if (!("processes" in response) || (response.next !== null && response.next <= cursor))
      throw new Error("invalid host listing")
    processes.push(...response.processes)
    cursor = response.next
  }
  return processes
}
