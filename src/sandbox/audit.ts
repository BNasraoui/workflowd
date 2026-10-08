import { createHash, randomBytes } from "node:crypto"
import { mkdir, open, readdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Schema } from "effect"
import { readSandboxBinding, saveSandboxFile } from "./binding"
import { sandboxSshArguments, type SandboxTransport } from "./transport"

const maxRecords = 1024
const maxLine = 4096
const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const Output = Schema.Struct({
  content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
  isError: Schema.optionalKey(Schema.Boolean),
})
const Audit = Schema.Struct({
  runId: Schema.String,
  leaseId: Schema.String,
  sequence: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maxRecords })),
  callId: Schema.String,
  tool: Schema.String,
  command: Schema.NullOr(Schema.String),
  commandSha256: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
  outcome: Schema.Literals(["ok", "error", "unknown"]),
  complete: Schema.Boolean,
})
export type ToolAudit = typeof Audit.Type
export const AuditReceipt = Schema.Struct({
  emittedThrough: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: maxRecords })),
})

type Call = { name: string; arguments: Record<string, Schema.Json> }

// This preview is public. Redaction is deliberately conservative, not a secret detector.
function preview(command: string) {
  return command
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g,
      "[redacted]",
    )
    .replace(
      /(\b(?:token|password|secret|authorization|api[_-]?key)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s;]+)/gi,
      "$1[redacted]",
    )
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .slice(0, 512)
}

export function wrapAuditedCommand(call: Call) {
  if (call.name !== "environment_run_cmd" || call.arguments.background === true)
    return { call, nonce: null }
  const command = call.arguments.command
  if (typeof command !== "string" || command.length === 0) return { call, nonce: null }
  const shell = call.arguments.shell ?? "sh"
  if (typeof shell !== "string" || !/^(?:\/[a-zA-Z0-9/_.-]+|[a-zA-Z0-9_.-]+)$/.test(shell))
    throw new Error("Sandbox command shell is invalid")
  const nonce = randomBytes(16).toString("hex")
  // The original command is an argument to the inner shell, never shell source in the wrapper.
  const script =
    '"$2" -c "$1" wfd; status=$?; printf "\\nworkflowd.exit:' + nonce + ':%s\\n" "$status"'
  return {
    nonce,
    call: {
      ...call,
      arguments: {
        ...call.arguments,
        shell: "sh",
        command: `sh -c ${quote(script)} wfd ${quote(command)} ${quote(shell)}`,
      },
    },
  }
}

export function auditedOutput(value: unknown, nonce: string | null, commandTool: boolean) {
  const output = Schema.decodeUnknownSync(Output)(value)
  const codes: number[] = []
  const content = output.content.map((item) => ({
    ...item,
    text: item.text.replace(
      /^workflowd\.exit:([a-f0-9]{32}):([^\r\n]*)\r?\n?/gm,
      (line: string, found: string, status: string) => {
        if (nonce === null || found !== nonce) return line
        codes.push(
          line.endsWith("\n") && /^(?:0|[1-9][0-9]{0,2})$/.test(status) ? Number(status) : -1,
        )
        return ""
      },
    ),
  }))
  const exitCode = codes.length === 1 && codes[0]! >= 0 && codes[0]! <= 255 ? codes[0]! : null
  const outcome = commandTool
    ? exitCode === null
      ? "unknown"
      : exitCode === 0
        ? "ok"
        : "error"
    : output.isError === true
      ? "error"
      : "ok"
  return { result: { ...output, content }, exitCode, outcome } as const
}

function encode(record: ToolAudit) {
  const line = JSON.stringify(record)
  if (Buffer.byteLength(line) > maxLine) throw new Error("Sandbox audit record exceeds bound")
  return line
}

async function reserveToolAudit(bindingFile: string, id: string | number, params: unknown) {
  const binding = await readSandboxBinding(bindingFile.slice(0, -".sandbox/binding.json".length))
  const decoded = Schema.decodeUnknownOption(
    Schema.Struct({
      name: Schema.optionalKey(Schema.String),
      arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
    }),
  )(params)
  const call = decoded._tag === "Some" ? decoded.value : {}
  const command =
    call.name === "environment_run_cmd" && typeof call.arguments?.command === "string"
      ? call.arguments.command
      : null
  const root = join(dirname(bindingFile), "audit")
  await mkdir(root, { recursive: true, mode: 0o700 })
  for (;;) {
    const sequences = (await readdir(root))
      .filter((name) => /^[0-9]+\.json$/.test(name))
      .map((name) => Number(name.split(".")[0]))
    const sequence = Math.max(0, ...sequences) + 1
    if (sequence > maxRecords) throw new Error("Sandbox audit capacity exceeded")
    const record: ToolAudit = {
      runId: binding.runId,
      leaseId: binding.leaseId,
      sequence,
      callId: digest(String(id)),
      tool: (call.name ?? "invalid").slice(0, 128),
      command: command === null ? null : preview(command),
      commandSha256: command === null ? null : digest(command),
      exitCode: null,
      outcome: "unknown",
      complete: false,
    }
    let file
    try {
      file = await open(join(root, `${sequence}.json`), "wx", 0o600)
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")
        continue
      throw error
    }
    try {
      await file.writeFile(encode(record))
      await file.sync()
    } finally {
      await file.close()
    }
    const parent = await open(root, "r")
    try {
      await parent.sync()
    } finally {
      await parent.close()
    }
    return {
      finish: async (exitCode: number | null, outcome: ToolAudit["outcome"]) => {
        const complete = { ...record, exitCode, outcome, complete: true }
        await saveSandboxFile(root, `${sequence}.json`, encode(complete))
        return complete
      },
    }
  }
}

export async function beginToolAudit(bindingFile: string, id: string | number, params: unknown) {
  try {
    return await reserveToolAudit(bindingFile, id, params)
  } catch (error) {
    await saveSandboxFile(dirname(bindingFile), "audit-failed", "Audit record reservation failed")
    throw error
  }
}

export async function sendToolAudit(
  transport: SandboxTransport,
  record: ToolAudit | ReadonlyArray<ToolAudit>,
) {
  const records = "sequence" in record ? [record] : record
  if (records.length > maxRecords) throw new Error("Sandbox audit capacity exceeded")
  const child = Bun.spawn(
    [...sandboxSshArguments(transport).slice(0, -1), "exec /usr/local/bin/runner-control audit"],
    {
      stdin: new Blob(["[" + records.map(encode).join(",") + "]"]),
      stdout: "pipe",
      stderr: "ignore",
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    },
  )
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000)
  try {
    const chunks: Uint8Array[] = []
    let length = 0
    for await (const chunk of child.stdout) {
      length += chunk.length
      if (length > maxLine) throw new Error("Sandbox audit receipt exceeds bound")
      chunks.push(chunk)
    }
    if ((await child.exited) !== 0) throw new Error("Sandbox audit delivery failed")
    return Schema.decodeUnknownSync(AuditReceipt)(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    )
  } finally {
    clearTimeout(timer)
    child.kill("SIGKILL")
    await child.exited
  }
}

export async function drainToolAudit(
  directory: string,
  deliver: (records: ReadonlyArray<ToolAudit>) => Promise<typeof AuditReceipt.Type>,
) {
  const root = join(`${directory}.sandbox`, "audit")
  if (!(await Bun.file(join(`${directory}.sandbox`, "binding.json")).exists())) return
  const binding = await readSandboxBinding(directory)
  const files = await readdir(root).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return []
    throw error
  })
  const names = files
    .filter((name) => /^[0-9]+\.json$/.test(name))
    .sort((a, b) => Number(a.split(".")[0]) - Number(b.split(".")[0]))
  if (names.length > maxRecords) throw new Error("Sandbox audit capacity exceeded")
  const acknowledged = (await deliver([])).emittedThrough
  if (acknowledged < 0 || acknowledged > names.length)
    throw new Error("Sandbox audit watermark exceeds canonical records")
  const pending: ToolAudit[] = []
  let complete = !(await Bun.file(join(`${directory}.sandbox`, "audit-failed")).exists())
  for (const [index, name] of names.entries()) {
    const text = await readFile(join(root, name), "utf8")
    if (Buffer.byteLength(text) > maxLine) throw new Error("Sandbox audit record exceeds bound")
    const record = Schema.decodeUnknownSync(Audit)(JSON.parse(text))
    if (record.runId !== binding.runId || record.leaseId !== binding.leaseId)
      throw new Error("Sandbox audit identity mismatch")
    if (record.sequence !== index + 1) throw new Error("Sandbox audit sequence is incomplete")
    complete &&= record.complete
    if (record.sequence > acknowledged) pending.push(record)
  }
  const emittedThrough =
    pending.length === 0 ? acknowledged : (await deliver(pending)).emittedThrough
  if (!complete || emittedThrough !== names.length)
    throw new Error("Sandbox audit drain unconfirmed")
  await saveSandboxFile(
    `${directory}.sandbox`,
    "audit-receipt.json",
    JSON.stringify({ emittedThrough }),
  )
}
