import { Effect, Schema } from "effect"
const Queued = Schema.Struct({
  data: Schema.Array(Schema.Struct({ clientUserMessageId: Schema.String })),
  nextCursor: Schema.NullOr(Schema.String),
})
const History = Schema.Struct({
  thread: Schema.Struct({
    turns: Schema.Array(
      Schema.Struct({
        items: Schema.Array(
          Schema.Struct({
            type: Schema.String,
            clientId: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
      }),
    ),
  }),
})
export type ResidentRequest = (method: string, params: unknown) => Promise<unknown>
/** A sending intent is never blindly retried after a lost acknowledgement. */
export const deliverResident = Effect.fn("Resident.deliver")(
  function* (
    request: ResidentRequest,
    message: {
      readonly id: string
      readonly thread_id: string
      readonly prompt: string
      readonly state: string
    },
  ) {
    if (message.state === "sending") {
      let cursor: string | null = null
      for (let page = 0; page < 10; page++) {
        const queued = yield* Effect.tryPromise(() =>
          request("thread/queue/list", { threadId: message.thread_id, cursor, limit: 100 }),
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Queued)))
        if (queued.data.some((item) => item.clientUserMessageId === message.id))
          return "delivered" as const
        cursor = queued.nextCursor
        if (cursor === null) break
      }
      const history = yield* Effect.tryPromise(() =>
        request("thread/read", { threadId: message.thread_id, includeTurns: true }),
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(History)))
      return history.thread.turns.some((turn) =>
        turn.items.some((item) => item.type === "userMessage" && item.clientId === message.id),
      )
        ? ("delivered" as const)
        : ("uncertain" as const)
    }
    yield* Effect.tryPromise(() =>
      request("thread/queue/add", {
        threadId: message.thread_id,
        clientUserMessageId: message.id,
        input: [{ type: "text", text: message.prompt, text_elements: [] }],
      }),
    )
    return "delivered" as const
  },
  Effect.matchEffect({
    onSuccess: Effect.succeed,
    onFailure: () => Effect.succeed("uncertain" as const),
  }),
)
