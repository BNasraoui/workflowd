import { expect, test } from "bun:test"
import { Effect, Result } from "effect"
import {
  decodeRemoteCommand,
  decodeRemoteHostMessage,
  decodeRemoteResult,
  encodeRemoteCommand,
  encodeRemoteResult,
} from "../../src/remote/codec"
import {
  MAX_CLAUDE_RESUME_OUTPUT_BYTES,
  MAX_CLAUDE_RESUME_PROMPT_BYTES,
  MAX_REMOTE_MESSAGE_BYTES,
  type RemoteCommand,
  type RemoteResult,
} from "../../src/remote/contract"

test("rejects malformed JSON before contract handling", async () => {
  const result = await Effect.runPromise(
    decodeRemoteHostMessage(new TextEncoder().encode("{not-json")).pipe(Effect.result),
  )

  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) expect(result.failure.reason).toBe("malformed")
})

test("rejects oversized bytes before JSON or schema decoding", async () => {
  const result = await Effect.runPromise(
    decodeRemoteResult(new Uint8Array(MAX_REMOTE_MESSAGE_BYTES + 1)).pipe(Effect.result),
  )

  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) expect(result.failure.reason).toBe("oversized")
})

const probeCommand: RemoteCommand = {
  version: 1,
  commandId: "command-1",
  jobId: "job-1",
  attempt: 1,
  generation: 1,
  hostId: "host-a",
  kind: "probe",
  issuedAt: "2026-08-31T00:00:00.000Z",
  expiresAt: "2026-08-31T00:05:00.000Z",
}

const claudePayload = {
  kind: "claude_resume" as const,
  hostId: "host-a",
  nativeSessionId: "0c0ffee0-cafe-4dad-b0ba-000000000001",
  directory: "/home/example/repos/workflowd",
  prompt: '{"task":"WAKE: the child finished."}',
  extractionSchemaJson: '{"type":"object"}',
  turnTimeoutMs: 120_000,
}

test("probe command and result encodings are byte-identical to the pre-claude contract", async () => {
  const commandBytes = await Effect.runPromise(encodeRemoteCommand(probeCommand))
  // The exact wire form a pre-claude peer produces and expects: no payload
  // key, no output/failureReason keys.
  expect(JSON.parse(new TextDecoder().decode(commandBytes))).toEqual({
    version: 1,
    commandId: "command-1",
    jobId: "job-1",
    attempt: 1,
    generation: 1,
    hostId: "host-a",
    kind: "probe",
    issuedAt: "2026-08-31T00:00:00.000Z",
    expiresAt: "2026-08-31T00:05:00.000Z",
  })
  const resultBytes = await Effect.runPromise(
    encodeRemoteResult({
      version: 1,
      resultId: "result-1",
      commandId: "command-1",
      jobId: "job-1",
      attempt: 1,
      generation: 1,
      hostId: "host-a",
      kind: "probe",
      status: "succeeded",
      observedAt: "2026-08-31T00:01:00.000Z",
    }),
  )
  const resultShape: unknown = JSON.parse(new TextDecoder().decode(resultBytes))
  if (typeof resultShape !== "object" || resultShape === null) {
    throw new Error("expected an encoded object")
  }
  const resultKeys = Object.keys(resultShape)
  expect(resultKeys).not.toContain("payload")
  expect(resultKeys).not.toContain("output")
})

test("claude_resume commands round-trip and require their payload", async () => {
  const command: RemoteCommand = { ...probeCommand, kind: "claude_resume", payload: claudePayload }
  const bytes = await Effect.runPromise(encodeRemoteCommand(command))
  const decoded = await Effect.runPromise(decodeRemoteCommand(bytes))
  expect(decoded).toEqual(command)

  // A claude_resume command without a payload is not a member of the union.
  const missing = await Effect.runPromise(
    decodeRemoteCommand(
      new TextEncoder().encode(JSON.stringify({ ...probeCommand, kind: "claude_resume" })),
    ).pipe(Effect.result),
  )
  expect(Result.isFailure(missing)).toBe(true)
  // A probe command with a payload is rejected as excess.
  const excess = await Effect.runPromise(
    decodeRemoteCommand(
      new TextEncoder().encode(JSON.stringify({ ...probeCommand, payload: claudePayload })),
    ).pipe(Effect.result),
  )
  expect(Result.isFailure(excess)).toBe(true)
})

test("claude_resume results pair status with output or failureReason, never both", async () => {
  const base = {
    version: 1 as const,
    resultId: "result-2",
    commandId: "command-2",
    jobId: "job-2",
    attempt: 1,
    generation: 1,
    hostId: "host-a",
    kind: "claude_resume",
    observedAt: "2026-08-31T00:01:00.000Z",
  }
  const succeeded: RemoteResult = {
    ...base,
    kind: "claude_resume",
    status: "succeeded",
    output: '{"acknowledged":true,"summary":"woken"}',
  }
  const roundTripped = await Effect.runPromise(
    encodeRemoteResult(succeeded).pipe(Effect.flatMap(decodeRemoteResult)),
  )
  expect(roundTripped).toEqual(succeeded)

  const failed: RemoteResult = {
    ...base,
    kind: "claude_resume",
    status: "failed",
    failureReason: "transcript_missing",
  }
  expect(
    await Effect.runPromise(encodeRemoteResult(failed).pipe(Effect.flatMap(decodeRemoteResult))),
  ).toEqual(failed)

  for (const invalid of [
    { ...base, status: "succeeded" }, // succeeded without output
    { ...base, status: "failed" }, // failed without reason
    {
      ...base,
      status: "succeeded",
      output: "{}",
      failureReason: "cli_failed", // both present
    },
    { ...base, status: "failed", output: "{}", failureReason: "cli_failed" },
  ]) {
    const result = await Effect.runPromise(
      decodeRemoteResult(new TextEncoder().encode(JSON.stringify(invalid))).pipe(Effect.result),
    )
    expect(Result.isFailure(result)).toBe(true)
  }
})

test("claude_resume sub-budgets refuse oversized prompts and outputs", async () => {
  const oversizedPrompt = await Effect.runPromise(
    encodeRemoteCommand({
      ...probeCommand,
      kind: "claude_resume",
      payload: { ...claudePayload, prompt: "x".repeat(MAX_CLAUDE_RESUME_PROMPT_BYTES + 1) },
    }).pipe(Effect.result),
  )
  expect(Result.isFailure(oversizedPrompt)).toBe(true)

  const oversizedOutput = await Effect.runPromise(
    encodeRemoteResult({
      version: 1,
      resultId: "result-3",
      commandId: "command-3",
      jobId: "job-3",
      attempt: 1,
      generation: 1,
      hostId: "host-a",
      kind: "claude_resume",
      status: "succeeded",
      output: "y".repeat(MAX_CLAUDE_RESUME_OUTPUT_BYTES + 1),
      observedAt: "2026-08-31T00:01:00.000Z",
    }).pipe(Effect.result),
  )
  expect(Result.isFailure(oversizedOutput)).toBe(true)
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
  const result = await Effect.runPromise(decodeRemoteResult(bytes).pipe(Effect.result))

  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) expect(result.failure.reason).toBe("malformed")
})
