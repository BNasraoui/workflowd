import { expect, test } from "bun:test"
import { Effect, Either } from "effect"
import { decodeRemoteHostMessage, decodeRemoteResult } from "../../src/remote/codec"
import { MAX_REMOTE_MESSAGE_BYTES } from "../../src/remote/contract"

test("rejects malformed JSON before contract handling", async () => {
  const result = await Effect.runPromise(
    decodeRemoteHostMessage(new TextEncoder().encode("{not-json")).pipe(Effect.either),
  )

  expect(Either.isLeft(result)).toBe(true)
  if (Either.isLeft(result)) expect(result.left.reason).toBe("malformed")
})

test("rejects oversized bytes before JSON or schema decoding", async () => {
  const result = await Effect.runPromise(
    decodeRemoteResult(new Uint8Array(MAX_REMOTE_MESSAGE_BYTES + 1)).pipe(Effect.either),
  )

  expect(Either.isLeft(result)).toBe(true)
  if (Either.isLeft(result)) expect(result.left.reason).toBe("oversized")
})

test("rejects a timestamp that is well-formed but not a real instant", async () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      resultId: "result-invalid-time",
      commandId: "command-invalid-time",
      jobId: "job-invalid-time",
      attempt: 1,
      generation: 1,
      hostId: "host-a",
      kind: "probe",
      status: "succeeded",
      observedAt: "2026-99-99T12:00:00.000Z",
    }),
  )
  const result = await Effect.runPromise(decodeRemoteResult(bytes).pipe(Effect.either))

  expect(Either.isLeft(result)).toBe(true)
  if (Either.isLeft(result)) expect(result.left.reason).toBe("malformed")
})
