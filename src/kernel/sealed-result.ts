import { lstat, mkdtemp, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { inflateSync } from "node:zlib"
import { Data, Effect, Redacted, type Scope } from "effect"

/**
 * The daemon's check of a sealed result from a run placed off the host, and its
 * push of the checked result to one target ref. A result is data: no part of it
 * is used as a path, a ref or an option of a command. Git runs in a scratch bare
 * repository with no checkout, so no hook, filter or attribute of the result runs.
 */

const MiB = 1024 * 1024

/** The bounds of a result, and the time and disk the check may use. */
export const sealedResultLimits = {
  manifestBytes: 256 * 1024,
  bundleBytes: 16 * MiB,
  commits: 100,
  objects: 10_000,
  objectBytes: 64 * MiB,
  changedPaths: 100,
  blobBytes: MiB,
  titleCharacters: 200,
  commitMessageBytes: 10 * 1024,
  bodyBytes: 32 * 1024,
  finalMessageBytes: 64 * 1024,
  /** Wall clock for the whole check, and again for the push; a git child is killed at it. */
  timeLimitMs: 120_000,
  /** No file a git child writes may pass it, and the scratch directory may not hold more. */
  diskBytes: 128 * MiB,
  /** Address space of each git child. */
  memoryBytes: 1024 * MiB,
} as const

/** The shape a run sends back. result.json holds every key but the bundle, and no other key. */
export type SealedResult = {
  readonly sourceSha: string
  readonly bundle: Uint8Array
  readonly title: string
  readonly commitMessage: string
  readonly body: string
  readonly finalMessage: string
}

export type SealedResultTarget = {
  /** The daemon's ref, such as `refs/heads/agent-run/<id>`; never a value of the result. */
  readonly ref: string
  /** The head the target must have, or null when the target must not exist yet. */
  readonly expectedHead: string | null
}

export type SealedResultOptions = {
  /** Git URL of the target repository. */
  readonly remote: string
  /** The source commit the daemon chose at start. */
  readonly sourceSha: string
  /** The installation token; it reaches git only through the environment. */
  readonly token?: Redacted.Redacted<string>
  readonly blockedEmails: ReadonlyArray<string>
  /** A directory of the daemon in which each check makes and removes its scratch repository. */
  readonly scratchRoot: string
  readonly gitBinary?: string
  readonly timeLimitMs?: number
}

export type SealedResultCheck =
  | "manifest"
  | "unknown_key"
  | "missing_key"
  | "source"
  | "title"
  | "commit_message"
  | "body"
  | "final_message"
  | "bundle_size"
  | "bundle_format"
  | "ref"
  | "base"
  | "object_count"
  | "object_bytes"
  | "fsck"
  | "disk_limit"
  | "time_limit"
  | "commit_count"
  | "linear_history"
  | "file_mode"
  | "mode_change"
  | "github_path"
  | "changed_paths"
  | "blob_size"
  | "identity"
  | "target_exists"
  | "target_moved"

export class SealedResultRefused extends Data.TaggedError("SealedResultRefused")<{
  readonly check: SealedResultCheck
  readonly detail: string
  readonly message: string
}> {}

export class SealedResultFault extends Data.TaggedError("SealedResultFault")<{
  readonly operation: string
  readonly message: string
}> {}

export type SealedResultError = SealedResultRefused | SealedResultFault

const refused = (check: SealedResultCheck, detail = "") =>
  new SealedResultRefused({
    check,
    detail,
    message: detail === "" ? `result_refused: ${check}` : `result_refused: ${check} ${detail}`,
  })

/** Text of the result inside a refusal: quoted, printable and short. */
const quoted = (value: string) =>
  JSON.stringify(value.length > 64 ? `${value.slice(0, 64)}…` : value)

const decoder = new TextDecoder("utf-8", { fatal: true })
const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength
const commitId = /^[0-9a-f]{40}$/
// A title is one line; a message or body may hold newlines and no other control.
const controlOrFormat = /[\p{Cc}\p{Cf}\u2028\u2029]/u
const controlButNewline = /(?![\n])[\p{Cc}\p{Cf}]/u

const manifestKeys = ["sourceSha", "title", "commitMessage", "body", "finalMessage"] as const

const textChecks: ReadonlyArray<
  readonly [(typeof manifestKeys)[number], SealedResultCheck, (value: string) => boolean]
> = [
  ["sourceSha", "source", (value) => commitId.test(value)],
  [
    "title",
    "title",
    (value) =>
      value.length > 0 &&
      [...value].length <= sealedResultLimits.titleCharacters &&
      !controlOrFormat.test(value),
  ],
  [
    "commitMessage",
    "commit_message",
    (value) =>
      value.length > 0 &&
      utf8Bytes(value) <= sealedResultLimits.commitMessageBytes &&
      !controlButNewline.test(value),
  ],
  [
    "body",
    "body",
    (value) =>
      value.trim().length > 0 &&
      utf8Bytes(value) <= sealedResultLimits.bodyBytes &&
      !controlButNewline.test(value),
  ],
  [
    "finalMessage",
    "final_message",
    (value) => utf8Bytes(value) <= sealedResultLimits.finalMessageBytes && !value.includes("\0"),
  ],
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseManifest = (json: Uint8Array): Record<string, unknown> | undefined => {
  if (json.byteLength > sealedResultLimits.manifestBytes) return undefined
  try {
    const value: unknown = JSON.parse(decoder.decode(json))
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Reads result.json and the bundle into a SealedResult, or refuses by the check that fails. */
export const decodeSealedResult = (
  json: Uint8Array,
  bundle: Uint8Array,
): Effect.Effect<SealedResult, SealedResultRefused> =>
  Effect.suspend(() => {
    const manifest = parseManifest(json)
    if (manifest === undefined) return Effect.fail(refused("manifest"))
    const unknown = Object.keys(manifest).find(
      (key) => !(manifestKeys as ReadonlyArray<string>).includes(key),
    )
    if (unknown !== undefined) return Effect.fail(refused("unknown_key", quoted(unknown)))
    const missing = manifestKeys.find((key) => !Object.hasOwn(manifest, key))
    if (missing !== undefined) return Effect.fail(refused("missing_key", quoted(missing)))
    const text: Partial<Record<(typeof manifestKeys)[number], string>> = {}
    for (const [key, check, valid] of textChecks) {
      const value = manifest[key]
      if (typeof value !== "string" || !valid(value)) return Effect.fail(refused(check))
      text[key] = value
    }
    return Effect.succeed({
      sourceSha: text.sourceSha!,
      bundle,
      title: text.title!,
      commitMessage: text.commitMessage!,
      body: text.body!,
      finalMessage: text.finalMessage!,
    })
  })

type BundleHeader = {
  readonly prerequisites: ReadonlyArray<string>
  readonly refs: ReadonlyArray<{ readonly sha: string; readonly name: string }>
  readonly packOffset: number
}

/** The v2 bundle header: `-<sha> <comment>` prerequisites, `<sha> <ref>` refs, a blank line. */
const parseBundleHeader = (bundle: Uint8Array): BundleHeader | SealedResultRefused => {
  const end = bundle.subarray(0, 64 * 1024).indexOf(0x0a)
  const signature = "# v2 git bundle"
  if (end < 0 || new TextDecoder().decode(bundle.subarray(0, end)) !== signature)
    return refused("bundle_format")
  const prerequisites: string[] = []
  const refs: { sha: string; name: string }[] = []
  let offset = end + 1
  for (;;) {
    const next = bundle.indexOf(0x0a, offset)
    if (next < 0 || next - offset > 4096) return refused("bundle_format")
    const line = new TextDecoder().decode(bundle.subarray(offset, next))
    offset = next + 1
    if (line === "") break
    const prerequisite = /^-([0-9a-f]{40})(?: .*)?$/.exec(line)
    const ref = /^([0-9a-f]{40}) (\S+)$/.exec(line)
    if (prerequisite !== null) prerequisites.push(prerequisite[1]!)
    else if (ref !== null) refs.push({ sha: ref[1]!, name: ref[2]! })
    else return refused("bundle_format")
    if (prerequisites.length + refs.length > 16) return refused("bundle_format")
  }
  return { prerequisites, refs, packOffset: offset }
}

/** Reads a variable-length size of the pack format at `offset`. */
const readSize = (bytes: Uint8Array, offset: number, first: number, shift: number) => {
  let size = first
  let position = offset
  let byte = bytes[position - 1]!
  let bits = shift
  while (byte & 0x80) {
    if (position >= bytes.length || bits > 49) return undefined
    byte = bytes[position++]!
    size += (byte & 0x7f) * 2 ** bits
    bits += 7
  }
  return { size, position }
}

// With `info`, inflateSync returns the output and its engine, whose bytesWritten is
// the input it consumed: where the next object of the pack starts.
const isInflateInfo = (
  value: unknown,
): value is { readonly buffer: Buffer; readonly engine: { readonly bytesWritten: number } } =>
  isRecord(value) &&
  Buffer.isBuffer(value.buffer) &&
  isRecord(value.engine) &&
  typeof value.engine.bytesWritten === "number"

const inflateBounded = (bytes: Uint8Array, offset: number, size: number) => {
  try {
    const output: unknown = inflateSync(bytes.subarray(offset), {
      info: true,
      maxOutputLength: Math.max(size, 1),
    })
    return isInflateInfo(output) && output.buffer.byteLength === size
      ? { data: output.buffer, end: offset + output.engine.bytesWritten }
      : undefined
  } catch {
    return undefined
  }
}

/** The result size a delta declares: after its base size, both as 7-bit varints. */
const deltaResultSize = (delta: Uint8Array) => {
  let position = 0
  let value = 0
  for (let field = 0; field < 2; field++) {
    value = 0
    for (let shift = 0; ; shift += 7) {
      if (position >= delta.length || shift > 49) return undefined
      const byte = delta[position++]!
      value += (byte & 0x7f) * 2 ** shift
      if (!(byte & 0x80)) break
    }
  }
  return value
}

/**
 * Walks the pack of a bundle before git reads it. Each object is inflated with an
 * output cap of the size it declares, so the work of the check stays inside the
 * bounds during the unpack: the count, the inflated bytes and each object's size.
 */
const scanPack = (pack: Uint8Array): SealedResultRefused | undefined => {
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength)
  if (pack.byteLength < 32 || new TextDecoder().decode(pack.subarray(0, 4)) !== "PACK")
    return refused("bundle_format")
  const version = view.getUint32(4)
  const count = view.getUint32(8)
  if (version !== 2 && version !== 3) return refused("bundle_format")
  if (count > sealedResultLimits.objects)
    return refused("object_count", `${count} objects; the bound is ${sealedResultLimits.objects}`)
  let offset = 12
  let inflated = 0
  let objectBytes = 0
  for (let index = 0; index < count; index++) {
    if (offset >= pack.byteLength - 20) return refused("bundle_format")
    const first = pack[offset]!
    const type = (first >> 4) & 7
    const header = readSize(pack, offset + 1, first & 0x0f, 4)
    if (header === undefined) return refused("bundle_format")
    offset = header.position
    if (type === 6) {
      while (offset < pack.byteLength && pack[offset]! & 0x80) offset++
      offset++
    } else if (type === 7) offset += 20
    else if (type < 1 || type > 4) return refused("bundle_format")
    inflated += header.size
    if (inflated > sealedResultLimits.objectBytes)
      return refused("object_bytes", `the bound is ${sealedResultLimits.objectBytes} bytes`)
    const entry = inflateBounded(pack, offset, header.size)
    if (entry === undefined) return refused("bundle_format")
    const size = type >= 6 ? deltaResultSize(entry.data) : header.size
    if (size === undefined) return refused("bundle_format")
    objectBytes += size
    if (objectBytes > sealedResultLimits.objectBytes)
      return refused("object_bytes", `the bound is ${sealedResultLimits.objectBytes} bytes`)
    offset = entry.end
  }
  return offset === pack.byteLength - 20 ? undefined : refused("bundle_format")
}

/** Checks of the bundle that need no git: size, header, base and the pack bounds. */
const checkBundle = (
  result: SealedResult,
  base: string,
): SealedResultRefused | { readonly resultSha: string; readonly packOffset: number } => {
  if (result.bundle.byteLength > sealedResultLimits.bundleBytes)
    return refused("bundle_size", `the bound is ${sealedResultLimits.bundleBytes} bytes`)
  const header = parseBundleHeader(result.bundle)
  if (header instanceof SealedResultRefused) return header
  if (header.refs.length !== 1 || header.refs[0]!.name !== "refs/workflowd/result")
    return refused("ref", "the bundle must hold exactly refs/workflowd/result")
  if (header.prerequisites.length !== 1 || header.prerequisites[0] !== base)
    return refused("base", `the single prerequisite must be ${base}`)
  return (
    scanPack(result.bundle.subarray(header.packOffset)) ?? {
      resultSha: header.refs[0]!.sha,
      packOffset: header.packOffset,
    }
  )
}

type GitRun = {
  readonly status: number
  readonly stdout: Uint8Array
  readonly stderr: string
  readonly timedOut: boolean
}

type GitContext = {
  readonly binary: string
  readonly env: Record<string, string>
  readonly cwd: string
  readonly deadline: number
  readonly timeLimitMs: number
  readonly secrets: ReadonlyArray<string>
}

// Each git child sees this configuration and nothing of the caller's.
const gitConfig = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.attributesFile=/dev/null",
  "credential.helper=",
  "transfer.fsckObjects=true",
  "fetch.fsckObjects=true",
  "transfer.unpackLimit=1",
  "fetch.unpackLimit=1",
  "core.bigFileThreshold=1m",
  "gc.auto=0",
  "maintenance.auto=false",
  "fetch.recurseSubmodules=false",
  "http.followRedirects=false",
  "protocol.allow=never",
  "protocol.file.allow=always",
  "protocol.https.allow=always",
].flatMap((entry) => ["-c", entry])

const gitEnvironment = (remote: string, token: Redacted.Redacted<string> | undefined) => {
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    HOME: "/nonexistent",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ALLOW_PROTOCOL: "file:https",
  }
  if (token === undefined) return { env, secrets: [] }
  const basic = Buffer.from(`x-access-token:${Redacted.value(token)}`).toString("base64")
  // The token is a header of the target URL only, set through the environment.
  env.GIT_CONFIG_COUNT = "1"
  env.GIT_CONFIG_KEY_0 = `http.${remote}.extraHeader`
  env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`
  return { env, secrets: [Redacted.value(token), basic] }
}

const redact = (text: string, secrets: ReadonlyArray<string>) =>
  secrets
    .reduce((value, secret) => value.split(secret).join("[redacted]"), text)
    .replace(/[^\x20-\x7e\n]/g, "?")
    .slice(0, 2000)

const readBounded = async (stream: ReadableStream<Uint8Array>, limit: number) => {
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const chunk of stream) {
    length += chunk.byteLength
    if (length > limit) throw new Error("git output exceeded its bound")
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

const killGroup = (pid: number) => {
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    // The group has already ended.
  }
}

const spawnGit = async (
  context: GitContext,
  args: ReadonlyArray<string>,
  input: Uint8Array | undefined,
): Promise<GitRun> => {
  const remaining = context.deadline - Date.now()
  if (remaining <= 0) return { status: -1, stdout: new Uint8Array(), stderr: "", timedOut: true }
  const limits = `ulimit -f ${sealedResultLimits.diskBytes / 512} && ulimit -v ${sealedResultLimits.memoryBytes / 1024} && exec "$0" "$@"`
  const child = Bun.spawn(["/bin/sh", "-c", limits, context.binary, ...gitConfig, ...args], {
    cwd: context.cwd,
    env: context.env,
    detached: true,
    stdin: input === undefined ? "ignore" : input,
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killGroup(child.pid)
  }, remaining)
  try {
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      readBounded(child.stdout, 16 * MiB),
      readBounded(child.stderr, 64 * 1024),
    ])
    return { status, stdout, stderr: stderr.toString("utf8"), timedOut }
  } finally {
    clearTimeout(timer)
    killGroup(child.pid)
  }
}

/** Runs git; a time-out refuses, any other failure is passed to `onFailure`. */
const git = (
  context: GitContext,
  args: ReadonlyArray<string>,
  input?: Uint8Array,
): Effect.Effect<GitRun, SealedResultError> =>
  Effect.tryPromise({
    try: () => spawnGit(context, args, input),
    catch: (cause) =>
      new SealedResultFault({
        operation: args[0] ?? "git",
        message: redact(`git ${args[0]} failed: ${String(cause)}`, context.secrets),
      }),
  }).pipe(
    Effect.flatMap((run) =>
      run.timedOut
        ? Effect.fail(refused("time_limit", `the bound is ${context.timeLimitMs} ms`))
        : Effect.succeed(run),
    ),
  )

const gitOk = (context: GitContext, args: ReadonlyArray<string>, input?: Uint8Array) =>
  git(context, args, input).pipe(
    Effect.flatMap((run) =>
      run.status === 0
        ? Effect.succeed(new TextDecoder().decode(run.stdout))
        : Effect.fail(
            new SealedResultFault({
              operation: args[0] ?? "git",
              message: redact(
                `git ${args[0]} exited ${run.status}: ${run.stderr}`,
                context.secrets,
              ),
            }),
          ),
    ),
  )

const directoryBytes = async (path: string) => {
  let total = 0
  for (const entry of await readdir(path, { recursive: true }))
    total += (await lstat(join(path, entry))).size
  return total
}

const checkDisk = (scratch: string) =>
  Effect.tryPromise({
    try: () => directoryBytes(scratch),
    catch: () =>
      new SealedResultFault({ operation: "disk", message: "Scratch directory size unreadable" }),
  }).pipe(
    Effect.flatMap((bytes) =>
      bytes > sealedResultLimits.diskBytes
        ? Effect.fail(refused("disk_limit", `the bound is ${sealedResultLimits.diskBytes} bytes`))
        : Effect.void,
    ),
  )

const targetRef = /^refs\/heads\/(?!-)[A-Za-z0-9._/-]{1,200}$/

/** The target's current head, or null when it does not exist. */
const readTarget = (context: GitContext, remote: string, ref: string) =>
  gitOk(context, ["ls-remote", "--refs", "--", remote, ref]).pipe(
    Effect.map((output) => {
      const line = output
        .split("\n")
        .map((entry) => entry.split("\t"))
        .find((fields) => fields[1] === ref)
      return line?.[0] ?? null
    }),
  )

type DiffEntry = {
  readonly oldMode: string
  readonly newMode: string
  readonly blob: string
  readonly path: string
}

const parseDiff = (raw: string): ReadonlyArray<DiffEntry> => {
  const fields = raw.split("\0")
  const entries: DiffEntry[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [oldMode, newMode, , blob] = fields[index]!.replace(/^:/, "").split(" ")
    entries.push({ oldMode: oldMode!, newMode: newMode!, blob: blob!, path: fields[index + 1]! })
  }
  return entries
}

const regularModes = new Set(["000000", "100644", "100755"])

const checkEntry = (entry: DiffEntry): SealedResultRefused | undefined => {
  if (!regularModes.has(entry.oldMode) || !regularModes.has(entry.newMode))
    return refused("file_mode", quoted(entry.path))
  if (entry.oldMode !== "000000" && entry.newMode !== "000000" && entry.oldMode !== entry.newMode)
    return refused("mode_change", quoted(entry.path))
  if (entry.path.split("/")[0]!.toLowerCase() === ".github")
    return refused("github_path", quoted(entry.path))
  return undefined
}

/** Paths and modes of each commit, the changed path count and each new blob's size. */
const checkChanges = (context: GitContext, commits: ReadonlyArray<string>, base: string) =>
  Effect.gen(function* () {
    const changed = new Set<string>()
    const blobs = new Map<string, string>()
    let parent = base
    for (const commit of commits) {
      const raw = yield* gitOk(context, [
        "diff-tree",
        "-r",
        "--raw",
        "--no-renames",
        "-z",
        parent,
        commit,
      ])
      for (const entry of parseDiff(raw)) {
        const refusal = checkEntry(entry)
        if (refusal !== undefined) return yield* refusal
        changed.add(entry.path)
        if (entry.newMode !== "000000") blobs.set(entry.blob, entry.path)
      }
      if (changed.size > sealedResultLimits.changedPaths)
        return yield* refused("changed_paths", `the bound is ${sealedResultLimits.changedPaths}`)
      parent = commit
    }
    const shas = [...blobs.keys()]
    const sizes = yield* gitOk(
      context,
      ["cat-file", "--batch-check=%(objectsize)"],
      new TextEncoder().encode(shas.map((sha) => `${sha}\n`).join("")),
    )
    const lines = sizes.trim().split("\n")
    const index = lines.findIndex((line) => Number(line) > sealedResultLimits.blobBytes)
    if (index >= 0)
      return yield* refused(
        "blob_size",
        `${quoted(blobs.get(shas[index]!)!)} is over ${sealedResultLimits.blobBytes} bytes`,
      )
  })

/** History from the base: 1–100 commits, each with the previous one as its single parent. */
const checkHistory = (context: GitContext, base: string, resultSha: string) =>
  Effect.gen(function* () {
    const range = `${base}..${resultSha}`
    const lines = (yield* gitOk(context, ["rev-list", "--reverse", "--parents", range]))
      .trim()
      .split("\n")
      .filter((line) => line !== "")
    if (lines.length < 1 || lines.length > sealedResultLimits.commits)
      return yield* refused(
        "commit_count",
        `${lines.length} commits; the bound is 1 to ${sealedResultLimits.commits}`,
      )
    let parent = base
    const commits: string[] = []
    for (const line of lines) {
      const [commit, ...parents] = line.split(" ")
      if (parents.length !== 1 || parents[0] !== parent) return yield* refused("linear_history")
      commits.push(commit!)
      parent = commit!
    }
    if (parent !== resultSha) return yield* refused("linear_history")
    const objects = (yield* gitOk(context, ["rev-list", "--objects", range])).trim().split("\n")
    if (objects.length > sealedResultLimits.objects) return yield* refused("object_count")
    const sizes = yield* gitOk(
      context,
      ["cat-file", "--batch-check=%(objectsize)"],
      new TextEncoder().encode(objects.map((line) => `${line.slice(0, 40)}\n`).join("")),
    )
    const total = sizes
      .trim()
      .split("\n")
      .reduce((sum, line) => sum + Number(line), 0)
    if (total > sealedResultLimits.objectBytes) return yield* refused("object_bytes")
    return commits
  })

const checkIdentity = (
  context: GitContext,
  base: string,
  resultSha: string,
  blockedEmails: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const blocked = new Set(blockedEmails.map((email) => email.trim().toLowerCase()))
    const emails = (yield* gitOk(context, [
      "log",
      "--format=%ae%x00%ce%x00",
      `${base}..${resultSha}`,
    ]))
      .split("\0")
      .map((email) => email.trim().toLowerCase())
    if (emails.some((email) => blocked.has(email))) return yield* refused("identity")
  })

export type CheckedSealedResult = {
  readonly resultSha: string
  readonly target: SealedResultTarget
  readonly push: () => Effect.Effect<
    { readonly ref: string; readonly sha: string },
    SealedResultError
  >
}

/**
 * Checks a sealed result in a scratch bare repository that lives as long as the
 * scope. Refuses `result_refused: <check>` when a check of the result fails; a
 * fault of the daemon or the remote is a SealedResultFault.
 */
export const checkSealedResult = (
  result: SealedResult,
  target: SealedResultTarget,
  options: SealedResultOptions,
): Effect.Effect<CheckedSealedResult, SealedResultError, Scope.Scope> =>
  Effect.gen(function* () {
    if (!targetRef.test(target.ref) || target.ref.includes(".."))
      return yield* new SealedResultFault({ operation: "target", message: "Invalid target ref" })
    if (target.expectedHead !== null && !commitId.test(target.expectedHead))
      return yield* new SealedResultFault({ operation: "target", message: "Invalid expected head" })
    if (result.sourceSha !== options.sourceSha) return yield* refused("source")
    const base = target.expectedHead ?? options.sourceSha
    const bundle = checkBundle(result, base)
    if (bundle instanceof SealedResultRefused) return yield* bundle
    const scratch = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => mkdtemp(join(options.scratchRoot, "sealed-result-")),
        catch: () =>
          new SealedResultFault({ operation: "scratch", message: "Scratch directory unavailable" }),
      }),
      (path) =>
        Effect.promise(() =>
          rm(path, { recursive: true, force: true }).then(
            () => true,
            () => false,
          ),
        ).pipe(
          Effect.flatMap((removed) =>
            removed ? Effect.void : Effect.logWarning("Sealed result scratch directory remains"),
          ),
        ),
    )
    const { env, secrets } = gitEnvironment(options.remote, options.token)
    const timeLimitMs = options.timeLimitMs ?? sealedResultLimits.timeLimitMs
    const context: GitContext = {
      binary: options.gitBinary ?? "/usr/bin/git",
      env,
      cwd: scratch,
      deadline: Date.now() + timeLimitMs,
      timeLimitMs,
      secrets,
    }
    const repository = join(scratch, "repository.git")
    yield* gitOk(context, ["init", "--quiet", "--bare", "--template=", repository])
    const inRepository: GitContext = { ...context, cwd: repository }
    const head = yield* readTarget(inRepository, options.remote, target.ref)
    if (target.expectedHead === null && head !== null) return yield* refused("target_exists")
    if (target.expectedHead !== null && head !== target.expectedHead)
      return yield* refused("target_moved")
    yield* gitOk(inRepository, [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      "--depth=1",
      "--",
      options.remote,
      `${base}:refs/workflowd/base`,
    ])
    // index-pack reads the pack of the bundle from stdin under --strict (fsck of every
    // object); a bundle fetch of this git version does not fsck what it unpacks.
    const unpack = yield* git(
      inRepository,
      [
        "index-pack",
        "--stdin",
        "--fix-thin",
        "--strict",
        `--max-input-size=${sealedResultLimits.bundleBytes}`,
      ],
      result.bundle.subarray(bundle.packOffset),
    )
    if (unpack.status !== 0)
      return yield* refused(
        "fsck",
        JSON.stringify(redact(unpack.stderr, secrets).split("\n")[0] ?? ""),
      )
    const commit = yield* git(inRepository, ["cat-file", "-t", bundle.resultSha])
    if (commit.status !== 0 || new TextDecoder().decode(commit.stdout).trim() !== "commit")
      return yield* refused("ref", "the ref of the bundle names no commit of its pack")
    yield* checkDisk(scratch)
    const commits = yield* checkHistory(inRepository, base, bundle.resultSha)
    yield* checkChanges(inRepository, commits, base)
    yield* checkIdentity(inRepository, base, bundle.resultSha, options.blockedEmails)
    return {
      resultSha: bundle.resultSha,
      target,
      push: () =>
        pushChecked(
          { ...inRepository, deadline: Date.now() + timeLimitMs },
          options.remote,
          target,
          bundle.resultSha,
        ),
    }
  })

const pushChecked = (
  context: GitContext,
  remote: string,
  target: SealedResultTarget,
  resultSha: string,
) =>
  Effect.gen(function* () {
    // The lease makes the remote refuse a target that appeared or moved since the
    // check; the refspec has no `+`, so the push is never forced.
    const lease = `--force-with-lease=${target.ref}:${target.expectedHead ?? ""}`
    const run = yield* git(context, [
      "push",
      "--porcelain",
      "--no-verify",
      lease,
      "--",
      remote,
      `${resultSha}:${target.ref}`,
    ])
    const stdout = new TextDecoder().decode(run.stdout)
    const status = stdout.split("\n").find((line) => line.includes(`:${target.ref}\t`))
    if (
      run.status === 0 &&
      status !== undefined &&
      (status.startsWith("*\t") || status.startsWith(" \t"))
    )
      return { ref: target.ref, sha: resultSha }
    if (status?.startsWith("!\t"))
      return yield* refused(target.expectedHead === null ? "target_exists" : "target_moved")
    return yield* new SealedResultFault({
      operation: "push",
      message: redact(`git push exited ${run.status}: ${run.stderr}`, context.secrets),
    })
  })

/** Pushes a checked result to its target ref, inside the scope of its check. */
export const pushSealedResult = (checked: CheckedSealedResult) => checked.push()
