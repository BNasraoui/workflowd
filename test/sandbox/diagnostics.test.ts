import { expect, test } from "bun:test"
import { Cause } from "effect"
import { sandboxDiagnostic } from "../../src/sandbox/diagnostics"
import { SandboxError } from "../../src/sandbox/store"

test("diagnostics retain nested causes, statuses and timing across public error mappings", () => {
  const started = Date.now() - 20
  const original = Object.assign(new Error("SSH refused"), {
    exitCode: 255,
    code: "ECONNREFUSED",
    cause: Object.assign(new TypeError("service unavailable"), { response: { status: 503 } }),
  })
  const peer = new SandboxError(sandboxDiagnostic("peer.heartbeat", original, started))
  const mapped = new SandboxError(sandboxDiagnostic("prepareNative", peer, started))
  const terminal = sandboxDiagnostic("native.startup", Cause.fail(mapped), started)
  expect(terminal.message).toContain("SSH refused")
  expect(terminal.evidence.causes.find((entry) => entry.exitCode === 255)).toMatchObject({
    stage: "peer.heartbeat",
    errorClass: "Error",
    exitCode: 255,
    code: "ECONNREFUSED",
  })
  expect(terminal.evidence.causes.find((entry) => entry.httpStatus === 503)).toMatchObject({
    errorClass: "TypeError",
    httpStatus: 503,
    message: "service unavailable",
  })
  expect(terminal.evidence.elapsedMs).toBeGreaterThanOrEqual(20)
})

test("diagnostics omit credentials, SDK payloads and schema inputs and bound cyclic causes", () => {
  const secrets = [
    "bearer-canary",
    "basic-canary",
    "query-canary",
    "user-canary",
    "pass-canary",
    "key-canary",
    "body-canary",
    "json-canary",
  ]
  const error = Object.assign(
    new Error(
      [
        "Peer refused",
        "Authorization: Bearer bearer-canary",
        "Basic basic-canary",
        "https://user-canary:pass-canary@host/path?signature=query-canary",
        "api_key=key-canary",
        '{"access_token":"json-canary"}',
        "-----BEGIN PRIVATE KEY-----\nprivate-canary\n-----END PRIVATE KEY-----",
      ].join("\n"),
    ),
    { request: { body: "body-canary" }, cause: {} },
  )
  error.cause = error
  const diagnostic = sandboxDiagnostic("peer.status", error)
  expect(diagnostic.message).toContain("Peer refused")
  for (const secret of [...secrets, "private-canary"])
    expect(diagnostic.message).not.toContain(secret)
  expect(diagnostic.evidence.causes).toHaveLength(1)
  const schema = sandboxDiagnostic("binding", { _tag: "SchemaError", message: "raw secret input" })
  expect(schema.message).not.toContain("raw secret input")
  const huge = sandboxDiagnostic("transport", new Error("x".repeat(20000)))
  expect(huge.message.length).toBeLessThan(8192)
})

test("diagnostics keep both the original failure and a cleanup failure, including Effect defects", () => {
  const error = new AggregateError([new Error("Peer initialization failed")], "Cleanup failed", {
    cause: Object.assign(new Error("Removal refused"), { code: "EACCES" }),
  })
  const diagnostic = sandboxDiagnostic("peer.cleanup", Cause.die(error))
  expect(diagnostic.message).toContain("Peer initialization failed")
  expect(diagnostic.message).toContain("Removal refused")
  expect(diagnostic.message).toContain("EACCES")
  expect(diagnostic.evidence.causes).toHaveLength(3)
})

test("mixed aggregate and retained causes respect the bound and keep the deepest failure", () => {
  const original = new SandboxError(sandboxDiagnostic("inner", new Error("deepest failure")))
  const wrapped = new SandboxError(sandboxDiagnostic("outer", original))
  const error = new AggregateError([
    ...Array.from({ length: 6 }, () => new Error("secondary")),
    wrapped,
  ])
  const diagnostic = sandboxDiagnostic("terminal", error)
  expect(diagnostic.evidence.causes.length).toBeLessThanOrEqual(8)
  expect(diagnostic.message).toContain("deepest failure")
})

test("JSON escaping cannot expand the diagnostic beyond its byte budget", () => {
  const cause = new AggregateError(Array.from({ length: 7 }, () => new Error("\ud800".repeat(512))))
  const diagnostic = sandboxDiagnostic("terminal", cause)
  expect(Buffer.byteLength(diagnostic.message)).toBeLessThan(8192)
})
