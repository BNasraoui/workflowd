import { Effect, Exit, Fiber, Schema } from "effect"
import { normalizeError } from "../errors"
import type { OpenCodeAdapter } from "./adapter"

type SessionEvent = Awaited<
  ReturnType<OpenCodeAdapter["subscribeSessionEvents"]>
> extends AsyncIterable<infer Event>
  ? Event
  : never
type AssistantMessage = Extract<
  SessionEvent,
  { readonly type: "message.updated" }
>["message"]
type SessionInput = Parameters<OpenCodeAdapter["getSessionStatus"]>[0]

type StructuredSessionRequest = {
  readonly directory: string
  readonly title: string
  readonly agent: string
  readonly model: Parameters<OpenCodeAdapter["promptSession"]>[0]["model"]
  readonly format: {
    readonly type: "json_schema"
    readonly schema: object
    readonly retryCount: number
  }
  readonly prompt: string
  readonly pollIntervalMs: number
}

type TerminalCandidate =
  | { readonly type: "message"; readonly message: AssistantMessage }
  | { readonly type: "error"; readonly error: Error }

type TerminalMessage<A> =
  | { readonly type: "result"; readonly value: A }
  | { readonly type: "error"; readonly error: Error }

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

export class StructuredSession<A, I> {
  private session: SessionInput | undefined

  constructor(
    private readonly adapter: OpenCodeAdapter,
    private readonly request: StructuredSessionRequest,
    private readonly schema: Schema.Schema<A, I>,
  ) {}

  async run(signal?: AbortSignal): Promise<A> {
    const execution = Effect.gen(this, function* () {
      const created = yield* this.call("create session", (operationSignal) =>
        this.adapter.createSession(
          { directory: this.request.directory, title: this.request.title },
          operationSignal,
        ),
      )
      this.session = {
        sessionID: created.id,
        directory: this.request.directory,
      }

      const initialEvents = yield* Effect.fork(this.consumeEventSubscription())
      yield* this.call("prompt session", (operationSignal) =>
        this.adapter.promptSession(
          {
            ...this.session!,
            agent: this.request.agent,
            model: this.request.model,
            format: this.request.format,
            parts: [{ type: "text", text: this.request.prompt }],
          },
          operationSignal,
        ),
      )

      return yield* Effect.raceFirst(
        this.waitForEvents(Fiber.join(initialEvents)),
        this.pollForCompletion(),
      )
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit) && this.session !== undefined
          ? this.abortSession(this.session)
          : Effect.void,
      ),
    )

    try {
      return await Effect.runPromise(execution, { signal })
    } catch (cause) {
      if (cause instanceof StructuredSessionError) throw cause
      throw new StructuredSessionError(
        "wait for structured session",
        normalizeError(signal?.aborted === true ? signal.reason : cause),
      )
    }
  }

  private waitForEvents(
    initial: Effect.Effect<TerminalMessage<A> | undefined, StructuredSessionError>,
  ): Effect.Effect<A, StructuredSessionError> {
    return Effect.gen(this, function* () {
      let terminal = yield* initial
      while (terminal === undefined) {
        yield* Effect.sleep(this.request.pollIntervalMs)
        terminal = yield* this.consumeEventSubscription()
      }
      return yield* settle(terminal)
    })
  }

  private pollForCompletion(): Effect.Effect<A, StructuredSessionError> {
    return Effect.gen(this, function* () {
      let inactivePolls = 0
      while (true) {
        yield* Effect.sleep(this.request.pollIntervalMs)
        const completion = yield* this.pollOnce()
        if (completion?.terminal !== undefined) {
          return yield* settle(completion.terminal)
        }
        if (completion?.active === true) {
          inactivePolls = 0
        } else if (completion !== undefined && ++inactivePolls >= 2) {
          return yield* waitFailure(
            new Error("OpenCode session remained idle without structured output"),
          )
        }
      }
    })
  }

  private pollOnce(): Effect.Effect<
    { readonly active: boolean; readonly terminal?: TerminalMessage<A> } | undefined,
    StructuredSessionError
  > {
    return Effect.gen(this, function* () {
      const status = yield* this.call("get session status", (signal) =>
        this.adapter.getSessionStatus(this.session!, signal),
      ).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
      if (status === undefined) return undefined
      if (status?.type === "busy" || status?.type === "retry") {
        return { active: true }
      }
      const messages = yield* this.call("list session messages", (signal) =>
        this.adapter.listSessionMessages(this.session!, signal),
      ).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
      if (messages === undefined) return undefined
      const candidate = findTerminalCandidate(messages)
      const terminal =
        candidate === undefined ? undefined : yield* this.decode(candidate)
      return terminal === undefined
        ? { active: false }
        : { active: false, terminal }
    })
  }

  private consumeEventSubscription(): Effect.Effect<
    TerminalMessage<A> | undefined,
    StructuredSessionError
  > {
    return Effect.gen(this, function* () {
      const candidate = yield* this.call(
        "subscribe to session events",
        async (signal) => {
          const events = await this.adapter.subscribeSessionEvents(
            { directory: this.request.directory },
            signal,
          )
          for await (const event of events) {
            const terminal = yieldEventTerminal(event, this.session!.sessionID)
            if (terminal !== undefined) return terminal
          }
          return undefined
        },
      ).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
      if (candidate === undefined) return undefined
      if (candidate.type !== "idle") return yield* this.decode(candidate)

      const messages = yield* this.call("list session messages", (signal) =>
        this.adapter.listSessionMessages(this.session!, signal),
      ).pipe(Effect.catchAll(() => Effect.succeed([])))
      const message = findTerminalCandidate(messages)
      return yield* this.decode(
        message ?? {
          type: "error",
          error: new Error(
            "OpenCode session became idle without structured output",
          ),
        },
      )
    })
  }

  private decode(
    candidate: TerminalCandidate,
  ): Effect.Effect<TerminalMessage<A>, StructuredSessionError> {
    if (candidate.type === "error") return Effect.succeed(candidate)
    return Schema.decodeUnknown(this.schema)(candidate.message.structured).pipe(
      Effect.map((value) => ({ type: "result", value }) as const),
      Effect.mapError(
        (cause) =>
          new StructuredSessionError(
            "decode structured session output",
            normalizeError(cause),
          ),
      ),
    )
  }

  private call<A>(
    operation: string,
    run: (signal: AbortSignal) => Promise<A>,
  ): Effect.Effect<A, StructuredSessionError> {
    return Effect.tryPromise({
      try: run,
      catch: (cause) => new StructuredSessionError(operation, normalizeError(cause)),
    })
  }

  private abortSession(
    session: SessionInput,
  ): Effect.Effect<void> {
    return Effect.tryPromise((signal) =>
      this.adapter.abortSession(session, signal),
    ).pipe(Effect.timeout("5 seconds"), Effect.ignore)
  }
}

function yieldEventTerminal(
  event: SessionEvent,
  sessionID: string,
): TerminalCandidate | { readonly type: "idle" } | undefined {
  if (event.type === "message.updated" && event.sessionID === sessionID) {
    return findTerminalCandidate([event.message])
  }
  if (
    event.type === "session.error" &&
    (event.sessionID === undefined || event.sessionID === sessionID)
  ) {
    return {
      type: "error",
      error: normalizeError(event.error ?? "OpenCode session failed"),
    }
  }
  if (
    event.type === "session.status" &&
    event.sessionID === sessionID &&
    event.status.type === "idle"
  ) {
    return { type: "idle" }
  }
  return undefined
}

function findTerminalCandidate(
  messages: ReadonlyArray<AssistantMessage>,
): TerminalCandidate | undefined {
  const completed = [...messages]
    .filter(
      (message) =>
        message.time.completed !== undefined &&
        (message.structured !== undefined || message.error !== undefined),
    )
    .sort((left, right) => right.time.created - left.time.created)[0]
  if (completed?.error !== undefined) {
    return { type: "error", error: normalizeError(completed.error) }
  }
  return completed === undefined
    ? undefined
    : { type: "message", message: completed }
}

function settle<A>(
  terminal: TerminalMessage<A>,
): Effect.Effect<A, StructuredSessionError> {
  return terminal.type === "result"
    ? Effect.succeed(terminal.value)
    : waitFailure(terminal.error)
}

function waitFailure(cause: Error): Effect.Effect<never, StructuredSessionError> {
  return Effect.fail(
    new StructuredSessionError("wait for structured session", cause),
  )
}
