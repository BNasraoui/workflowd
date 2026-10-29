import { Cause, Effect, Schema } from "effect"
import { saveSandboxFile } from "./binding"
import { sanitizeUntrustedText } from "../domain/head-evidence"

const Entry = Schema.Struct({
  stage: Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9.]{0,79}$/)),
  startedAt: Schema.String.check(Schema.isMaxLength(32)),
  elapsedMs: Schema.Number,
  errorClass: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9]{1,64}$/)),
  message: Schema.String.check(Schema.isMaxLength(512)),
  code: Schema.NullOr(Schema.String.check(Schema.isPattern(/^E[A-Z0-9_]{1,30}$/))),
  httpStatus: Schema.NullOr(Schema.Number),
  exitCode: Schema.NullOr(Schema.Number),
})
export const SandboxFailureEvidence = Schema.Struct({
  stage: Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9.]{0,79}$/)),
  startedAt: Schema.String.check(Schema.isMaxLength(32)),
  elapsedMs: Schema.Number,
  causes: Schema.Array(Entry).check(Schema.isMaxLength(8)),
})

const property = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined

// Bound the encoded bytes as well as the input characters (JSON escapes can expand them).
const encodedPreview = (value: string) => {
  let remaining = 512
  let result = ""
  for (const character of value) {
    const bytes = Buffer.byteLength(JSON.stringify(character)) - 2
    if (bytes > remaining) break
    result += character
    remaining -= bytes
  }
  return result
}

// Read messages only, never stacks, request/response bodies, headers or schema inputs.
// Redact before truncating so a credential crossing the limit cannot leave a prefix.
export const diagnosticMessage = (value: unknown) =>
  typeof value !== "string"
    ? ""
    : encodedPreview(
        sanitizeUntrustedText(
          value
            .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted URL]")
            .replace(/\b(?:Bearer|Basic)\s+[^\s"']+/gi, "[redacted credential]")
            .replace(
              /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g,
              "[redacted credential]",
            )
            .replace(
              /["']?\b[-A-Za-z0-9_]*(?:token|password|secret|authorization|api[_-]?key|cookie|credential)[-A-Za-z0-9_]*["']?\s*[=:][^\r\n]*/gi,
              "[redacted credential]",
            ),
          512,
        ),
      )
const integer = (value: unknown, min: number, max: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null

const classification = (value: unknown) => {
  const name = property(value, "_tag") ?? property(value, "name")
  return typeof name === "string" &&
    /^(?:[A-Z][A-Za-z0-9]{0,62}(?:Error|Exception)|Error|Interrupted|SandboxRefAbsent|SandboxRefRejected|SessionMissing)$/.test(
      name,
    )
    ? name
    : "UnknownError"
}

const retainedEntries = (current: unknown): Array<typeof Entry.Type> | undefined => {
  const saved = property(current, "evidence")
  if (!Schema.is(SandboxFailureEvidence)(saved)) return undefined
  const entries = saved.causes.map((entry) => ({
    ...entry,
    message: diagnosticMessage(entry.message),
  }))
  if (saved.causes[0]?.stage !== saved.stage)
    entries.unshift({
      stage: saved.stage,
      startedAt: saved.startedAt,
      elapsedMs: saved.elapsedMs,
      errorClass: classification(current),
      message: "Stage failed",
      code: null,
      httpStatus: null,
      exitCode: null,
    })
  return entries
}

// Follow the first failing path only; never format the issue or read its input.
const schemaFailureMessage = (error: unknown) => {
  if (!Schema.isSchemaError(error)) return "Schema validation failed"
  let issue = error.issue
  const path: PropertyKey[] = []
  for (let depth = 0; depth < 32; depth++) {
    if (issue._tag === "Pointer") {
      path.push(...issue.path)
      issue = issue.issue
    } else if (issue._tag === "Encoding" || issue._tag === "Filter") {
      issue = issue.issue
    } else if ((issue._tag === "Composite" || issue._tag === "AnyOf") && issue.issues.length > 0) {
      issue = issue.issues[0]!
    } else break
  }
  return diagnosticMessage(`Schema validation failed at ${path.map(String).join(".") || "$"}`)
}

const causeEntry = (stage: string, current: unknown, started: number): typeof Entry.Type => {
  const errorClass = classification(current)
  const code = property(current, "code")
  return {
    stage,
    startedAt: new Date(started).toISOString(),
    elapsedMs: Math.max(0, Date.now() - started),
    errorClass,
    message:
      errorClass === "SchemaError" || errorClass === "DecodeError"
        ? schemaFailureMessage(current)
        : diagnosticMessage(property(current, "message") ?? current),
    code: typeof code === "string" && /^E[A-Z0-9_]{1,30}$/.test(code) ? code : null,
    httpStatus: integer(
      property(current, "status") ?? property(property(current, "response"), "status"),
      100,
      599,
    ),
    exitCode: integer(property(current, "exitCode"), -255, 255),
  }
}

export function sandboxDiagnostic(stage: string, cause: unknown, started = Date.now()) {
  const causes: Array<typeof Entry.Type> = []
  const seen = new Set<unknown>()
  const pending = [cause]
  for (let depth = 0; pending.length > 0 && depth < 16 && causes.length < 8; depth++) {
    const current = pending.shift()
    if (current == null || seen.has(current)) continue
    seen.add(current)
    if (Cause.isCause(current)) {
      pending.push(
        ...current.reasons
          .slice(0, 8)
          .map((reason) =>
            Cause.isFailReason(reason)
              ? reason.error
              : Cause.isDieReason(reason)
                ? reason.defect
                : { name: "Interrupted" },
          ),
      )
      continue
    }
    const retained = retainedEntries(current)
    if (retained !== undefined) {
      causes.push(...retained.slice(-(8 - causes.length)))
      continue
    }
    causes.push(causeEntry(stage, current, started))
    pending.push(property(current, "reason"), property(current, "cause"))
    if (current instanceof AggregateError) {
      const errors: ReadonlyArray<unknown> = current.errors
      pending.push(...errors.slice(0, 8))
    }
  }
  const evidence = {
    stage,
    startedAt: new Date(started).toISOString(),
    elapsedMs: Math.max(0, Date.now() - started),
    causes,
  }
  return { message: `Sandbox ${stage} failed: ${JSON.stringify(evidence)}`, evidence }
}

export const retainSandboxFailure = (
  directory: string,
  stage: string,
  cause: unknown,
  started = Date.now(),
) => {
  const diagnostic = sandboxDiagnostic(stage, cause, started)
  return Effect.logError(diagnostic.message).pipe(
    Effect.andThen(
      Effect.tryPromise(() =>
        saveSandboxFile(
          directory,
          "sandbox-failure.json",
          JSON.stringify(diagnostic.evidence),
          true,
        ),
      ).pipe(Effect.ignore),
    ),
  )
}
