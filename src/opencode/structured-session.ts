import { Effect, Filter, Option, Schema, Stream } from "effect"
import { AgentOutputEnvelope, boundedAgentPayload } from "../agent-payload"
import { normalizeError } from "../errors"
import type {
  OpenCodeAdapter,
  OpenCodeAssistantMessage,
  OpenCodeModel,
  OpenCodeSessionEvent,
} from "./adapter"

export type StructuredSessionReference = {
  readonly sessionID: string
  readonly directory: string
}

type StructuredSessionRequest = {
  readonly directory: string
  readonly title: string
  readonly agent: string
  readonly model: OpenCodeModel
  readonly outputJsonSchema: object
  readonly retryCount: number
  readonly prompt: string
  readonly pollIntervalMs: number
  readonly maxOutputBytes: number
}

export class StructuredSessionError extends Error {
  readonly operation: string
  override readonly cause: Error

  constructor(operation: string, cause: Error) {
    super(`${operation}: ${cause.message}`, { cause })
    this.name = "StructuredSessionError"
    this.operation = operation
    this.cause = cause
  }
}

type TerminalOutcome =
  { readonly type: "completed" } | { readonly type: "error"; readonly error: Error }

// Runs one working session and turns its result into schema-valid output.
// The working session receives only the authored prompt; the output schema and
// any validation feedback travel through the adapter's transcript-neutral
// structured extraction, never through the working transcript.
export class StructuredSession<A, I> {
  constructor(
    private readonly adapter: OpenCodeAdapter,
    private readonly request: StructuredSessionRequest,
    private readonly schema: Schema.Codec<A, I>,
  ) {}

  create(): Effect.Effect<StructuredSessionReference, StructuredSessionError> {
    return this.adapter
      .createSession({
        directory: this.request.directory,
        title: this.request.title,
        agent: this.request.agent,
        model: this.request.model,
      })
      .pipe(
        Effect.mapError((cause) => this.fail("create session", cause)),
        Effect.map((created) => ({
          sessionID: created.id,
          directory: this.request.directory,
        })),
      )
  }

  resume(session: StructuredSessionReference): Effect.Effect<A, StructuredSessionError> {
    return Effect.gen({ self: this }, function* () {
      yield* this.adapter
        .promptSession({
          sessionID: session.sessionID,
          directory: session.directory,
          agent: this.request.agent,
          model: this.request.model,
          text: this.request.prompt,
        })
        .pipe(Effect.mapError((cause) => this.fail("prompt session", cause)))
      const terminal = yield* Effect.raceFirst(
        this.waitForEvents(session),
        this.pollForCompletion(session),
      )
      if (terminal.type === "error") {
        return yield* waitFailure(terminal.error)
      }
      yield* this.requireCompletedAnswer(session)
      return yield* this.extractStructuredOutput(session)
    })
  }

  run(): Effect.Effect<A, StructuredSessionError> {
    return Effect.flatMap(this.create(), (session) => this.resume(session))
  }

  private waitForEvents(
    session: StructuredSessionReference,
  ): Effect.Effect<TerminalOutcome, StructuredSessionError> {
    return Effect.gen({ self: this }, function* () {
      while (true) {
        const terminal = yield* this.consumeEventSubscription(session)
        if (terminal !== undefined) return terminal
        yield* Effect.sleep(this.request.pollIntervalMs)
      }
    })
  }

  private consumeEventSubscription(
    session: StructuredSessionReference,
  ): Effect.Effect<TerminalOutcome | undefined, never> {
    return this.adapter.subscribeSessionEvents({ directory: session.directory }).pipe(
      Stream.filterMap(
        Filter.fromPredicateOption((event: OpenCodeSessionEvent) =>
          Option.fromUndefinedOr(eventTerminal(event, session.sessionID)),
        ),
      ),
      Stream.runHead,
      Effect.map(Option.getOrUndefined),
      Effect.catch(() => Effect.succeed(undefined)),
    )
  }

  private pollForCompletion(
    session: StructuredSessionReference,
  ): Effect.Effect<TerminalOutcome, StructuredSessionError> {
    return Effect.gen({ self: this }, function* () {
      let inactivePolls = 0
      while (true) {
        yield* Effect.sleep(this.request.pollIntervalMs)
        const status = yield* this.adapter
          .getSessionStatus(session)
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (status?.type === "busy" || status?.type === "retry") {
          inactivePolls = 0
          continue
        }
        if (status?.type === "idle") {
          return { type: "completed" as const }
        }
        if (++inactivePolls >= 2) {
          return {
            type: "error" as const,
            error: new Error("OpenCode session remained unobservable without structured output"),
          }
        }
      }
    })
  }

  private requireCompletedAnswer(
    session: StructuredSessionReference,
  ): Effect.Effect<OpenCodeAssistantMessage, StructuredSessionError> {
    return this.adapter.listSessionMessages(session).pipe(
      Effect.mapError((cause) => this.fail("list session messages", cause)),
      Effect.flatMap((messages) => {
        const completed = [...messages]
          .filter((message) => message.time.completed !== undefined)
          .sort((left, right) => right.time.created - left.time.created)[0]
        if (completed === undefined) {
          return waitFailure(new Error("OpenCode session became idle without structured output"))
        }
        if (completed.error !== undefined) {
          return waitFailure(normalizeError(completed.error))
        }
        return Effect.succeed(completed)
      }),
    )
  }

  private extractStructuredOutput(
    session: StructuredSessionReference,
  ): Effect.Effect<A, StructuredSessionError> {
    return Effect.gen({ self: this }, function* () {
      let feedback: string | undefined
      let lastFailure: Error = new Error("Structured extraction did not run")
      for (let attempt = 0; attempt <= this.request.retryCount; attempt += 1) {
        const extracted = yield* this.adapter
          .generateStructured({
            sessionID: session.sessionID,
            directory: session.directory,
            jsonSchema: this.request.outputJsonSchema,
            ...(feedback === undefined ? {} : { feedback }),
          })
          .pipe(Effect.result)
        if (extracted._tag === "Failure") {
          return yield* Effect.fail(this.fail("generate structured output", extracted.failure))
        }
        const decoded = yield* this.decode(extracted.success).pipe(Effect.result)
        if (decoded._tag === "Success") {
          return decoded.success
        }
        lastFailure = decoded.failure.cause
        feedback = decoded.failure.cause.message
      }
      return yield* Effect.fail(
        new StructuredSessionError("decode structured session output", lastFailure),
      )
    })
  }

  private decode(value: unknown): Effect.Effect<A, StructuredSessionError> {
    return Schema.decodeUnknownEffect(AgentOutputEnvelope)(value).pipe(
      Effect.flatMap((encoded) =>
        Schema.decodeUnknownEffect(
          boundedAgentPayload(this.request.maxOutputBytes, "Agent harness output"),
        )(encoded),
      ),
      Effect.flatMap((encoded) => Schema.decodeUnknownEffect(this.schema)(encoded)),
      Effect.mapError(
        (cause) =>
          new StructuredSessionError("decode structured session output", normalizeError(cause)),
      ),
    )
  }

  private fail(operation: string, cause: unknown): StructuredSessionError {
    return cause instanceof StructuredSessionError
      ? cause
      : new StructuredSessionError(operation, normalizeError(cause))
  }
}

function eventTerminal(
  event: OpenCodeSessionEvent,
  sessionID: string,
): TerminalOutcome | undefined {
  if (event.type === "message.updated" && event.sessionID === sessionID) {
    if (event.message.time.completed === undefined) return undefined
    return event.message.error !== undefined
      ? { type: "error", error: normalizeError(event.message.error) }
      : { type: "completed" }
  }
  if (
    event.type === "session.error" &&
    (event.sessionID === undefined || event.sessionID === sessionID)
  ) {
    return { type: "error", error: normalizeError(event.error ?? "OpenCode session failed") }
  }
  if (
    event.type === "session.status" &&
    event.sessionID === sessionID &&
    event.status.type === "idle"
  ) {
    return { type: "completed" }
  }
  return undefined
}

function waitFailure(cause: Error): Effect.Effect<never, StructuredSessionError> {
  return Effect.fail(new StructuredSessionError("wait for structured session", cause))
}
