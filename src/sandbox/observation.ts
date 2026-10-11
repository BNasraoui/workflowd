import { Data, Effect } from "effect"
import { saveSandboxFile } from "./binding"

type Stage = "binding" | "preflight" | "session" | "catalog" | "telemetry"
type Evidence = {
  readonly stage: Stage
  readonly errorClass: string
  readonly httpStatus: number | null
  readonly startedAt: string
  readonly elapsedMs: number
}

// Only classifications cross the durable boundary. SDK errors can carry complete
// authenticated requests, response bodies and tool payloads in their causes.
const classes = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "UnknownError",
  "SchemaError",
  "SandboxError",
  "OpenCodeAdapterError",
  "ClientError",
  "HttpError",
  "HttpClientError",
  "TransportError",
  "StatusCodeError",
  "DecodeError",
  "EmptyBodyError",
  "TimeoutError",
  "TimeoutException",
  "SessionNotFoundError",
  "McpServerNotFoundError",
  "SessionMissing",
])
const property = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined

export class SandboxObservationError extends Data.TaggedError("SandboxObservationError")<{
  readonly evidence: Evidence
}> {
  override get message() {
    return `Sandbox observation failed: ${JSON.stringify(this.evidence)}`
  }
}

export function observationFailure(stage: Stage, cause: unknown, started: number) {
  let errorClass = "UnknownError"
  let httpStatus: number | null = null
  for (let depth = 0; cause != null && depth < 8; depth++) {
    if (cause instanceof SandboxObservationError) return cause
    const name = property(cause, "_tag") ?? property(cause, "name")
    if (typeof name === "string" && classes.has(name)) errorClass = name
    const status = property(cause, "status") ?? property(property(cause, "response"), "status")
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599)
      httpStatus = status
    cause = property(cause, "reason") ?? property(cause, "cause")
  }
  return new SandboxObservationError({
    evidence: {
      stage,
      errorClass,
      httpStatus,
      startedAt: new Date(started).toISOString(),
      elapsedMs: Math.max(0, Date.now() - started),
    },
  })
}

export const observeSandboxStage = <A, E, R>(stage: Stage, effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const started = Date.now()
    return effect.pipe(Effect.mapError((cause) => observationFailure(stage, cause, started)))
  })

export const observeSandboxTelemetry = <A, E, R>(
  directory: string,
  effect: Effect.Effect<A | undefined, E, R>,
) =>
  observeSandboxStage(
    "telemetry",
    effect.pipe(
      Effect.flatMap((telemetry) =>
        telemetry === undefined
          ? Effect.fail({ _tag: "SessionMissing" })
          : Effect.succeed(telemetry),
      ),
    ),
  ).pipe(
    Effect.tapError((failure) =>
      Effect.tryPromise(() =>
        saveSandboxFile(
          directory,
          "observation-failure.json",
          JSON.stringify(failure.evidence),
          true,
        ),
      ).pipe(
        // The same evidence remains in the terminal diagnostic if this duplicate file cannot be written.
        Effect.ignore,
      ),
    ),
  )
