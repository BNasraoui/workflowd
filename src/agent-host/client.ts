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
