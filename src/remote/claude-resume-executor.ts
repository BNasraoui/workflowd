import { credentialReason } from "../agent-host/protocol"
import { Context, Effect, Schema } from "effect"
import type { ClaudeCliPort } from "../kernel/claude-session"
import { structuredExtractionPrompt } from "../opencode/adapter"
import {
  MAX_CLAUDE_RESUME_OUTPUT_BYTES,
  type ClaudeResumeFailureReason,
  type ClaudeResumeJobV1,
} from "./contract"

/**
 * The runner-side effector for claude_resume commands: the one vetted thing
 * a coordinator can make this host do to a Claude session. It executes the
 * two CLI turns the daemon's same-host worker would run — the canonical
 * wake prompt, then the schema-bearing extraction with one feedback retry —
 * against a directory the runner has locally opted into. Every failure maps
 * to a wire-contract failure reason; the error channel is `never`, so no
 * executor condition can wedge the transport.
 *
 * The runner validates only that the extracted output is a single JSON
 * value within the wire budget; validating it against the trusted contract
 * schema stays the daemon's job.
 */
export type ClaudeResumeOutcome =
  | { readonly status: "pending" }
  | { readonly status: "succeeded"; readonly output: string }
  | {
      readonly status: "failed"
      readonly failureReason: ClaudeResumeFailureReason
      readonly failureDetail?: string
    }

export type ClaudeResumeExecutorPort = {
  readonly execute: (
    payload: ClaudeResumeJobV1,
    deliveryId?: string,
  ) => Effect.Effect<ClaudeResumeOutcome>
  readonly recover?: (
    payload: ClaudeResumeJobV1,
    deliveryId: string,
  ) => Effect.Effect<ClaudeResumeOutcome>
}

/**
 * Defaults to refusing everything: a runner that has not explicitly opted
 * directories in (WORKFLOWD_RUNNER_CLAUDE_DIRS) — or a composition that
 * never provided a live executor — executes nothing.
 */
export const ClaudeResumeExecutor = Context.Reference("workflowd/remote/ClaudeResumeExecutor", {
  defaultValue: (): ClaudeResumeExecutorPort => ({
    execute: () => Effect.succeed({ status: "failed", failureReason: "directory_not_allowed" }),
  }),
})

const CliEnvelope = Schema.Struct({ result: Schema.String })

const EXTRACTION_FEEDBACK = "The previous reply was not a single JSON value matching the schema."

const failed = (
  failureReason: ClaudeResumeFailureReason,
  failureDetail?: string,
): ClaudeResumeOutcome => ({
  status: "failed",
  failureReason,
  ...(failureDetail === undefined ? {} : { failureDetail }),
})

const underAllowedDirectory = (directory: string, prefixes: ReadonlyArray<string>) =>
  prefixes.some((prefix) => directory === prefix || directory.startsWith(`${prefix}/`))

/** Strips a markdown fence if the model wrapped its JSON in one. */
const unfence = (text: string) => {
  const trimmed = text.trim()
  return trimmed.startsWith("```")
    ? trimmed
        .replace(/^```[a-zA-Z]*\r?\n/, "")
        .replace(/\r?\n```$/, "")
        .trim()
    : trimmed
}

const parseJsonValue = (text: string): string | null => {
  const candidate = unfence(text)
  try {
    JSON.parse(candidate)
    return candidate
  } catch {
    return null
  }
}

/** The extraction schema must be a JSON object; anything else is a payload
 * the daemon should never have sent, reported as cli_failed. */
const parseSchemaObject = (json: string): object | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null
}

export const makeClaudeResumeExecutor = (options: {
  readonly cli: ClaudeCliPort
  /** Absolute directory prefixes this runner has opted in; empty refuses
   * every execution. */
  readonly allowedDirectories: ReadonlyArray<string>
}): ClaudeResumeExecutorPort => {
  const turn = (payload: ClaudeResumeJobV1, prompt: string, deliveryId?: string) =>
    options.cli
      .resume({
        nativeSessionId: payload.nativeSessionId,
        directory: payload.directory,
        prompt,
        timeoutMs: payload.turnTimeoutMs,
        ...(deliveryId === undefined ? {} : { deliveryId }),
      })
      .pipe(
        Effect.map((stdout) => ({ ok: true as const, stdout })),
        Effect.catch((error) =>
          credentialReason(error) === "credential_host_unreachable_or_timed_out"
            ? Effect.fail(error)
            : Effect.succeed({
                ok: false as const,
                failureReason:
                  credentialReason(error) ??
                  (error.cause.message.startsWith("host_request_refused")
                    ? ("host_request_refused" as const)
                    : String(error.cause.message).includes("did not finish within")
                      ? ("cli_timeout" as const)
                      : ("cli_failed" as const)),
                ...(error.cause.message.startsWith("host_request_refused")
                  ? { failureDetail: error.cause.message }
                  : {}),
              }),
        ),
      )

  const parseEnvelope = (stdout: string) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(CliEnvelope))(stdout.trim()).pipe(
      Effect.map((envelope) => envelope.result),
      Effect.option,
    )

  const execute = (payload: ClaudeResumeJobV1, deliveryId?: string) =>
    Effect.gen(function* () {
      if (!underAllowedDirectory(payload.directory, options.allowedDirectories)) {
        return failed("directory_not_allowed")
      }
      const exists = yield* options.cli
        .sessionExists({
          nativeSessionId: payload.nativeSessionId,
          directory: payload.directory,
        })
        .pipe(
          Effect.catch((error) =>
            credentialReason(error) === "credential_host_unreachable_or_timed_out"
              ? Effect.fail(error)
              : Effect.succeed(false),
          ),
        )
      if (!exists) return failed("transcript_missing")

      const schemaObject = parseSchemaObject(payload.extractionSchemaJson)
      if (schemaObject === null) return failed("cli_failed")

      const wake = yield* turn(
        payload,
        payload.prompt,
        deliveryId === undefined ? undefined : `${deliveryId}-wake`,
      )
      if (!wake.ok) return failed(wake.failureReason, wake.failureDetail)
      if ((yield* parseEnvelope(wake.stdout))._tag === "None") return failed("cli_failed")

      const extracted = yield* extractOutput(payload, schemaObject, deliveryId)
      if ("outcome" in extracted) return extracted.outcome
      if (new TextEncoder().encode(extracted.json).byteLength > MAX_CLAUDE_RESUME_OUTPUT_BYTES) {
        return failed("output_oversized")
      }
      return { status: "succeeded" as const, output: extracted.json }
    })

  /** One extraction turn plus a single feedback retry; the wake is never
   * re-sent. Returns the JSON answer or a terminal failure outcome. */
  const extractOutput = (payload: ClaudeResumeJobV1, schemaObject: object, deliveryId?: string) =>
    Effect.gen(function* () {
      const extractOnce = (feedback?: string) =>
        Effect.gen(function* () {
          const extraction = yield* turn(
            payload,
            structuredExtractionPrompt(schemaObject, ...(feedback === undefined ? [] : [feedback])),
            deliveryId === undefined
              ? undefined
              : `${deliveryId}-${feedback === undefined ? "extract" : "retry"}`,
          )
          if (!extraction.ok) {
            return { outcome: failed(extraction.failureReason, extraction.failureDetail) }
          }
          const answer = yield* parseEnvelope(extraction.stdout)
          if (answer._tag === "None") return { outcome: failed("cli_failed") }
          const json = parseJsonValue(answer.value)
          return json === null ? { retryable: true as const } : { json }
        })
      const first = yield* extractOnce()
      if ("outcome" in first) return { outcome: first.outcome }
      if ("json" in first) return { json: first.json }
      // One retry with feedback; the wake itself is never re-sent.
      const second = yield* extractOnce(EXTRACTION_FEEDBACK)
      if ("outcome" in second) return { outcome: second.outcome }
      if ("json" in second) return { json: second.json }
      return { outcome: failed("output_unparseable") }
    })

  const hasDelivery = options.cli.hasDelivery
  return {
    execute: (payload, deliveryId) =>
      execute(payload, deliveryId).pipe(
        Effect.catch(() => Effect.succeed({ status: "pending" as const })),
      ),
    ...(hasDelivery === undefined
      ? {}
      : {
          recover: (payload: ClaudeResumeJobV1, deliveryId: string) =>
            Effect.gen(function* () {
              const exists = yield* hasDelivery(`${deliveryId}-wake`).pipe(
                Effect.catch((error) =>
                  credentialReason(error) === "credential_host_unreachable_or_timed_out"
                    ? Effect.fail(error)
                    : Effect.succeed(false),
                ),
              )
              if (!exists) return failed("execution_interrupted")
              return yield* execute(payload, deliveryId)
            }).pipe(Effect.catch(() => Effect.succeed({ status: "pending" as const }))),
        }),
  }
}
