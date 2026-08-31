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
  | { readonly status: "succeeded"; readonly output: string }
  | { readonly status: "failed"; readonly failureReason: ClaudeResumeFailureReason }

export type ClaudeResumeExecutorPort = {
  readonly execute: (payload: ClaudeResumeJobV1) => Effect.Effect<ClaudeResumeOutcome>
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

const failed = (failureReason: ClaudeResumeFailureReason): ClaudeResumeOutcome => ({
  status: "failed",
  failureReason,
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

export const makeClaudeResumeExecutor = (options: {
  readonly cli: ClaudeCliPort
  /** Absolute directory prefixes this runner has opted in; empty refuses
   * every execution. */
  readonly allowedDirectories: ReadonlyArray<string>
}): ClaudeResumeExecutorPort => {
  const turn = (payload: ClaudeResumeJobV1, prompt: string) =>
    options.cli
      .resume({
        nativeSessionId: payload.nativeSessionId,
        directory: payload.directory,
        prompt,
        timeoutMs: payload.turnTimeoutMs,
      })
      .pipe(
        Effect.map((stdout) => ({ ok: true as const, stdout })),
        Effect.catch((error) =>
          Effect.succeed({
            ok: false as const,
            timedOut: String(error.cause.message).includes("did not finish within"),
          }),
        ),
      )

  const parseEnvelope = (stdout: string) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(CliEnvelope))(stdout.trim()).pipe(
      Effect.map((envelope) => envelope.result),
      Effect.option,
    )

  const execute: ClaudeResumeExecutorPort["execute"] = (payload) =>
    Effect.gen(function* () {
      if (!underAllowedDirectory(payload.directory, options.allowedDirectories)) {
        return failed("directory_not_allowed")
      }
      const exists = yield* options.cli
        .sessionExists({
          nativeSessionId: payload.nativeSessionId,
          directory: payload.directory,
        })
        .pipe(Effect.catch(() => Effect.succeed(false)))
      if (!exists) return failed("transcript_missing")

      let parsedSchema: unknown
      try {
        parsedSchema = JSON.parse(payload.extractionSchemaJson)
      } catch {
        return failed("cli_failed")
      }
      if (
        typeof parsedSchema !== "object" ||
        parsedSchema === null ||
        Array.isArray(parsedSchema)
      ) {
        return failed("cli_failed")
      }
      const schemaObject: object = parsedSchema

      const wake = yield* turn(payload, payload.prompt)
      if (!wake.ok) return failed(wake.timedOut ? "cli_timeout" : "cli_failed")
      if ((yield* parseEnvelope(wake.stdout))._tag === "None") return failed("cli_failed")

      const extractOnce = (feedback?: string) =>
        Effect.gen(function* () {
          const extraction = yield* turn(
            payload,
            structuredExtractionPrompt(schemaObject, ...(feedback === undefined ? [] : [feedback])),
          )
          if (!extraction.ok) {
            return { outcome: failed(extraction.timedOut ? "cli_timeout" : "cli_failed") }
          }
          const answer = yield* parseEnvelope(extraction.stdout)
          if (answer._tag === "None") return { outcome: failed("cli_failed") }
          const json = parseJsonValue(answer.value)
          return json === null ? { retryable: true as const } : { json }
        })

      let extracted: string
      const first = yield* extractOnce()
      if ("outcome" in first) return first.outcome
      if ("json" in first) {
        extracted = first.json
      } else {
        // One retry with feedback; the wake itself is never re-sent.
        const second = yield* extractOnce(EXTRACTION_FEEDBACK)
        if ("outcome" in second) return second.outcome
        if (!("json" in second)) return failed("output_unparseable")
        extracted = second.json
      }
      if (new TextEncoder().encode(extracted).byteLength > MAX_CLAUDE_RESUME_OUTPUT_BYTES) {
        return failed("output_oversized")
      }
      return { status: "succeeded", output: extracted }
    })

  return { execute }
}
