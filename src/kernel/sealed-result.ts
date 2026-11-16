import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { inflateSync } from "node:zlib"
import { Context, Data, Effect, Layer, Redacted, Schema, Semaphore, type Scope } from "effect"
import type { AgentGitConfig } from "../agent-git/config"
import { PublicationBody, PublicationMessage, PublicationTitle } from "../sandbox/config"
import { tryFileLock } from "../file-lock"
import { githubHost } from "../sandbox/github"

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
  /** A commit object: its four headers and its message. */
  commitBytes: 16 * 1024,
  bodyBytes: 32 * 1024,
  finalMessageBytes: 64 * 1024,
  /** Wall clock for the whole check, and again for the push; a git child is killed at it. */
  timeLimitMs: 120_000,
  /**
   * The scratch directory of one check holds no more at any moment: each git child
   * may write a third of what is left of it per file (see `fileLimitBlocks`).
   */
  diskBytes: 128 * MiB,
  /** Checks that hold a scratch directory at one time; a further check waits. */
  concurrentChecks: 4,
  /**
   * Checks that wait for a slot at one time; a further check is refused. Each runner
   * run sends one result, and 4 is the count of runner runs at one time in the plan,
   * so no more results than that wait when each runner run sends its result.
   */
  waitingChecks: 4,
  /**
   * How long a check waits for a slot. A slot is held by a check and its push, each
   * ended at `timeLimitMs`.
   */
  waitLimitMs: 240_000,
  /**
   * A git child that speaks to the remote and gets less than this many bytes a second
   * for `lowSpeedSeconds` ends, also when no daemon is left to kill it.
   */
  lowSpeedBytes: 1,
  lowSpeedSeconds: 30,
  /** Address space of each git child. */
  memoryBytes: 1024 * MiB,
} as const

/**
 * The shape a run sends back. result.json holds every key but the bundle, and no
 * other key. The commit message is in the commit objects of the bundle only.
 */
export type SealedResult = {
  readonly sourceSha: string
  readonly bundle: Uint8Array
  readonly title: string
  readonly body: string
  readonly finalMessage: string
}

export type SealedResultTarget = {
  /** The daemon's ref, such as `refs/heads/agent-run/<id>`; never a value of the result. */
  readonly ref: string
  /** The head the target must have, or null when the target must not exist yet. */
  readonly expectedHead: string | null
}

export type SealedResultOptions<E = never> = {
  /** Git URL of the target repository. */
  readonly remote: string
  /** The source commit the daemon chose at start. */
  readonly sourceSha: string
  /**
   * Makes the installation token, and revokes it when its scope closes. The check runs
   * it once it holds a slot, so a check that waits holds no token. The token reaches
   * only the git children that speak to the remote, through their environment.
   */
  readonly token: Effect.Effect<Redacted.Redacted<string>, E, Scope.Scope>
  /**
   * The identity the daemon gives agent runs: the author and the committer of each
   * commit, and the addresses no commit message may name.
   */
  readonly agentGit: AgentGitConfig
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
  | "path_name"
  | "changed_paths"
  | "blob_size"
  | "identity"
  | "commit_format"
  | "target_exists"
  | "target_moved"
  | "checks_waiting"
  | "wait_limit"

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

/**
 * A value the run controls, as text of a refusal, a log line or an error: printable
 * ASCII of at most `limit` characters. Each code point outside U+0020–U+007E, and each
 * `\` and `"`, is an escape, so no control, format or bidi character of the run
 * reaches a reader. A longer text ends in `...`.
 */
const printable = (value: string, limit: number) => {
  let text = ""
  for (const character of value) {
    const code = character.codePointAt(0)!
    const shown =
      character === "\\" || character === '"'
        ? `\\${character}`
        : code >= 0x20 && code <= 0x7e
          ? character
          : `\\u{${code.toString(16)}}`
    if (text.length + shown.length > limit - 3) return `${text}...`
    text += shown
  }
  return text
}

/** A value of the result inside a refusal: quoted, printable and short. */
const quoted = (value: string) => `"${printable(value, 120)}"`

const decoder = new TextDecoder("utf-8", { fatal: true })
const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength
const commitId = /^[0-9a-f]{40}$/
/**
 * The code points that a reader cannot see, as a class of the regular expression
 * engine: each format character (Cf: the bidi controls, the joiners, the byte order
 * mark and the tags among them) and each default-ignorable code point (the variation
 * selectors, the Hangul fillers and the reserved code points of that property among
 * them). No text and no path of a result holds one. The seal writes the second
 * property out as ranges (result.py DEFAULT_IGNORABLE); a test compares them.
 */
const invisible = String.raw`\p{Cf}\p{Default_Ignorable_Code_Point}`
/**
 * The text with each U+FE0F (emoji presentation) that directly follows a visible code point
 * left out: a commit message, a final message or a path may hold one there, and nowhere else,
 * so U+FE0F alone, after another invisible code point, after a control or after a space stays
 * refused. The seal has the same rule (result.py without_presentation).
 */
const presentationAfterVisible = new RegExp(String.raw`(?<=[^\p{Cc}${invisible}\s])\uFE0F`, "gu")
const withoutPresentation = (value: string) => value.replace(presentationAfterVisible, "")
// A title is one line; a body or a commit message may hold newlines and no other
// control; a final message may hold newlines and tabs and no other control. None
// holds an invisible code point.
const controlOrInvisible = new RegExp(String.raw`[\p{Cc}${invisible}\u2028\u2029]`, "u")
const controlButNewline = new RegExp(String.raw`(?![\n])[\p{Cc}${invisible}]`, "u")
const controlButNewlineOrTab = new RegExp(String.raw`(?![\n\t])[\p{Cc}${invisible}]`, "u")
// The publication rules of the seal (result.py safe_publication), with the same
// Unicode data: no mention, HTML, math, backslash, character reference, closing
// issue reference, link reference definition, stacked marks or ambiguous fence.
const isTitle = Schema.is(PublicationTitle)
const isBody = Schema.is(PublicationBody)

const manifestKeys = ["sourceSha", "title", "body", "finalMessage"] as const

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
      !controlOrInvisible.test(value) &&
      isTitle(value),
  ],
  [
    "body",
    "body",
    (value) =>
      value.trim().length > 0 &&
      utf8Bytes(value) <= sealedResultLimits.bodyBytes &&
      !controlButNewline.test(value) &&
      isBody(value),
  ],
  [
    "finalMessage",
    "final_message",
    (value) =>
      value.isWellFormed() &&
      utf8Bytes(value) <= sealedResultLimits.finalMessageBytes &&
      !controlButNewlineOrTab.test(withoutPresentation(value)),
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
  const signature = new TextEncoder().encode("# v2 git bundle\n")
  if (!signature.every((byte, index) => bundle[index] === byte)) return refused("bundle_format")
  const prerequisites: string[] = []
  const refs: { sha: string; name: string }[] = []
  let offset = signature.byteLength
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
  // git bundle writes version 2; no other version is read.
  if (version !== 2) return refused("bundle_format")
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
  /** A file the child, or a git child of it, wrote reached the limit of one file. */
  readonly diskFull: boolean
}

type GitContext = {
  readonly binary: string
  /** The `-c` options of each child. */
  readonly config: ReadonlyArray<string>
  readonly env: Record<string, string>
  readonly cwd: string
  /** The scratch directory of the check, whose size bounds what a child may write. */
  readonly scratch: string
  readonly deadline: number
  readonly timeLimitMs: number
  readonly secrets: ReadonlyArray<string>
}

/** The protocols a remote of the check may use: the daemon's are https only. */
export type SealedResultProtocol = "https" | "http" | "file"

// Each git child sees this configuration and nothing of the caller's.
const gitConfig = (protocols: ReadonlyArray<SealedResultProtocol>) =>
  [
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
    ...protocols.map((protocol) => `protocol.${protocol}.allow=always`),
  ].flatMap((entry) => ["-c", entry])

// A child that speaks to the remote ends when it gets almost no bytes.
const networkConfig = [
  `http.lowSpeedLimit=${sealedResultLimits.lowSpeedBytes}`,
  `http.lowSpeedTime=${sealedResultLimits.lowSpeedSeconds}`,
].flatMap((entry) => ["-c", entry])

const gitEnvironment = (
  protocols: ReadonlyArray<SealedResultProtocol>,
): Record<string, string> => ({
  PATH: "/usr/bin:/bin",
  HOME: "/nonexistent",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_ALLOW_PROTOCOL: protocols.join(":"),
})

/**
 * The context of the children that speak to the remote (ls-remote, fetch, push): the
 * token is a header of the target URL only, set through their environment. No other
 * child gets it.
 */
const networkContext = (
  context: GitContext,
  remote: string,
  token: Redacted.Redacted<string>,
): GitContext => {
  const basic = Buffer.from(`x-access-token:${Redacted.value(token)}`).toString("base64")
  return {
    ...context,
    config: [...context.config, ...networkConfig],
    env: {
      ...context.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${remote}.extraHeader`,
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    },
    secrets: [Redacted.value(token), basic],
  }
}

const withoutSecrets = (text: string, secrets: ReadonlyArray<string>) =>
  secrets.reduce((value, secret) => value.split(secret).join("[redacted]"), text)

/** The output of a git child inside a fault: no secret, and printable. */
const redact = (text: string, secrets: ReadonlyArray<string>) =>
  printable(withoutSecrets(text, secrets), 2000)

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

/** The total size of the files below a directory, and the size of the largest one. */
const directoryBytes = async (path: string) => {
  let total = 0
  let largest = 0
  for (const entry of await readdir(path, { recursive: true })) {
    const { size } = await lstat(join(path, entry))
    total += size
    largest = Math.max(largest, size)
  }
  return { total, largest }
}

// Room for the files of a few bytes a child writes: config, HEAD, refs, shallow, locks.
const smallFilesBytes = 64 * 1024

/**
 * The size limit, in the 512-byte blocks of `ulimit -f`, of each file a git child
 * may write. A child of the check writes at most three files that grow (a pack,
 * its index and its reverse index) and small files inside `smallFilesBytes`, so
 * a third of what is left of `diskBytes` per file keeps the scratch below it.
 */
const fileLimitBlocks = async (scratch: string) =>
  Math.floor(
    (sealedResultLimits.diskBytes - smallFilesBytes - (await directoryBytes(scratch)).total) /
      3 /
      512,
  )

const spawnGit = async (
  context: GitContext,
  args: ReadonlyArray<string>,
  input: Uint8Array | undefined,
  signal: AbortSignal,
): Promise<GitRun> => {
  const remaining = context.deadline - Date.now()
  const ended = {
    status: -1,
    stdout: new Uint8Array(),
    stderr: "",
    timedOut: false,
    diskFull: false,
  }
  if (remaining <= 0) return { ...ended, timedOut: true }
  const fileBlocks = await fileLimitBlocks(context.scratch)
  if (fileBlocks <= 0) return { ...ended, diskFull: true }
  if (signal.aborted) return ended
  const limits = `ulimit -f ${fileBlocks} && ulimit -v ${sealedResultLimits.memoryBytes / 1024} && exec "$0" "$@"`
  const child = Bun.spawn(["/bin/sh", "-c", limits, context.binary, ...context.config, ...args], {
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
  const stop = () => killGroup(child.pid)
  signal.addEventListener("abort", stop)
  try {
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      readBounded(child.stdout, 16 * MiB),
      readBounded(child.stderr, 64 * 1024),
    ])
    // A git child of the child (index-pack under fetch) ends by SIGXFSZ with no word in
    // the output of its parent, and leaves its file at the limit.
    const diskFull =
      status !== 0 &&
      (child.signalCode === "SIGXFSZ" ||
        (await directoryBytes(context.scratch)).largest >= fileBlocks * 512)
    return { status, stdout, stderr: stderr.toString("utf8"), timedOut, diskFull }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", stop)
    killGroup(child.pid)
  }
}

/**
 * Runs git; a time-out or a full disk refuses, a failure to run it is a fault. An
 * interruption kills the process group of the child at once and waits until the
 * child has ended, so the scratch directory is removed after it.
 */
const git = (
  context: GitContext,
  args: ReadonlyArray<string>,
  input?: Uint8Array,
): Effect.Effect<GitRun, SealedResultError> =>
  Effect.callback<GitRun, SealedResultFault>((resume) => {
    const controller = new AbortController()
    const running = spawnGit(context, args, input, controller.signal)
    void running.then(
      (run) => resume(Effect.succeed(run)),
      (cause: unknown) =>
        resume(
          Effect.fail(
            new SealedResultFault({
              operation: args[0] ?? "git",
              message: redact(`git ${args[0]} failed: ${String(cause)}`, context.secrets),
            }),
          ),
        ),
    )
    return Effect.promise(() => {
      controller.abort()
      return running.then(
        () => undefined,
        () => undefined,
      )
    })
  }).pipe(
    Effect.flatMap((run) =>
      run.timedOut
        ? Effect.fail(refused("time_limit", `the bound is ${context.timeLimitMs} ms`))
        : run.diskFull
          ? Effect.fail(refused("disk_limit", `the bound is ${sealedResultLimits.diskBytes} bytes`))
          : Effect.succeed(run),
    ),
  )

/** The output of a git child that succeeded, as bytes. */
const gitOkBytes = (context: GitContext, args: ReadonlyArray<string>, input?: Uint8Array) =>
  git(context, args, input).pipe(
    Effect.flatMap((run) =>
      run.status === 0
        ? Effect.succeed(run.stdout)
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

const gitOk = (context: GitContext, args: ReadonlyArray<string>, input?: Uint8Array) =>
  gitOkBytes(context, args, input).pipe(Effect.map((stdout) => new TextDecoder().decode(stdout)))

const scratchPrefix = "sealed-result-"

/**
 * The root of the scratch directories: made with mode 0700 when it does not exist,
 * else a directory (not a link) of the daemon's user that no other user may use.
 */
const scratchRootReady = (root: string) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(root, { mode: 0o700 }).catch((error: unknown) => {
        if (!isRecord(error) || error.code !== "EEXIST") throw error
      })
      const stat = await lstat(root)
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
        throw new Error("unsafe scratch root")
    },
    catch: () =>
      new SealedResultFault({
        operation: "scratch",
        message: "Scratch root is not a directory that only the daemon can use",
      }),
  })

/** The lock file of a runner, inside its scratch root. The removal of scratch keeps it. */
const scratchLockName = ".lock"

/**
 * Why the lock file at `path` cannot be taken, from what it is now: not a regular file
 * of one link, of another owner, of a mode other than 0600, or else (it is missing, or
 * open or flock(2) failed) an I/O error.
 */
const scratchLockFault = async (path: string, uid: number) => {
  const stat = await lstat(path).catch(() => undefined)
  const notPrivate =
    stat !== undefined &&
    (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1)
  if (!notPrivate) return "Scratch root lock cannot be opened or locked"
  if (!stat.isFile()) return "Scratch root lock is not a regular file of one link"
  if (stat.uid !== uid) return "Scratch root lock is not owned by the daemon"
  if ((stat.mode & 0o777) !== 0o600) return "Scratch root lock does not have mode 0600"
  return "Scratch root lock is not a regular file of one link"
}

/** The release of the lock, `held` when a live holder has it, or why it cannot be taken. */
const takeScratchLock = (path: string, uid: number) =>
  Effect.promise(() =>
    tryFileLock(path, uid, true).then(
      (release) => release ?? ("held" as const),
      async () => ({ fault: await scratchLockFault(path, uid) }),
    ),
  )

/**
 * Holds an exclusive flock(2) on `.lock` inside the scratch root for the scope of the
 * runner, so one runner at a time removes and bounds the scratch below a root, also in
 * one process. The file sits where the owner and the mode of the root are checked, so
 * every spelling of the root (a trailing `/`, a path through a symbolic link) reaches
 * one file, and no other user can make, open or replace it. The kernel releases the
 * lock when the process ends, SIGKILL included, so a lock that a dead process left
 * does not stop the next start. A live holder is `scratch_root_held`; each other cause
 * is a `scratch` fault with a text of its own.
 */
const holdScratchRoot = (root: string) =>
  Effect.acquireRelease(
    takeScratchLock(join(root, scratchLockName), process.getuid!()).pipe(
      Effect.flatMap((lock) =>
        lock === "held"
          ? Effect.fail(
              new SealedResultFault({
                operation: "scratch_root_held",
                message: "Scratch root is held by another git runner",
              }),
            )
          : typeof lock === "function"
            ? Effect.succeed(lock)
            : Effect.fail(new SealedResultFault({ operation: "scratch", message: lock.fault })),
      ),
    ),
    (release) =>
      Effect.promise(() =>
        release().then(
          () => true,
          () => false,
        ),
      ).pipe(
        Effect.flatMap((closed) =>
          closed ? Effect.void : Effect.logWarning("Sealed result scratch root lock remains"),
        ),
      ),
  )

/** Removes the scratch directories an earlier process of the daemon left below the root. */
const removeEarlierScratch = (root: string) =>
  Effect.tryPromise({
    try: async () => {
      for (const entry of await readdir(root))
        if (entry.startsWith(scratchPrefix))
          await rm(join(root, entry), { recursive: true, force: true })
    },
    catch: () =>
      new SealedResultFault({
        operation: "scratch",
        message: "Scratch directories of an earlier process remain",
      }),
  })

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
  /** The path, with each byte that is not UTF-8 as U+FFFD when `utf8` is false. */
  readonly path: string
  readonly utf8: boolean
}

/** The NUL-separated fields of `diff-tree -z`, each as bytes: a path may be any bytes. */
const nulFields = (raw: Uint8Array) => {
  const fields: Uint8Array[] = []
  let start = 0
  for (let end = raw.indexOf(0, start); end >= 0; end = raw.indexOf(0, start)) {
    fields.push(raw.subarray(start, end))
    start = end + 1
  }
  return fields
}

const parseDiff = (raw: Uint8Array): ReadonlyArray<DiffEntry> => {
  const fields = nulFields(raw)
  const entries: DiffEntry[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [oldMode, newMode, , blob] = new TextDecoder()
      .decode(fields[index])
      .replace(/^:/, "")
      .split(" ")
    const bytes = fields[index + 1]!
    let path: string
    let utf8 = true
    try {
      path = decoder.decode(bytes)
    } catch {
      path = new TextDecoder().decode(bytes)
      utf8 = false
    }
    entries.push({ oldMode: oldMode!, newMode: newMode!, blob: blob!, path, utf8 })
  }
  return entries
}

/**
 * What a path may not hold: a control character (C0, DEL and C1, so also no newline or
 * tab), a backslash in any component, and the characters that change what a reviewer
 * of the pushed result sees: each invisible code point (`invisible`), U+2028 and
 * U+2029, but U+FE0F directly after a visible code point (`withoutPresentation`). So a
 * file name with an emoji sequence that needs a joiner is refused. The seal has the same rule (result.py safe_path).
 */
const unsafePathCharacter = new RegExp(String.raw`[\p{Cc}\\${invisible}\u2028\u2029]`, "u")

const regularModes = new Set(["000000", "100644", "100755"])
const invisibleCharacters = new RegExp(`[${invisible}]`, "gu")

/**
 * Whether a first path component is `.github` or a name that a checkout on Windows
 * or macOS maps to it. The rule refuses more than the exact forms: any `~` (a short
 * name such as GITHUB~1) or `:` (a stream such as `::$INDEX_ALLOCATION`), and any
 * name that is `.github` in either case after NFKC, after dropping format and
 * default-ignorable characters (which HFS+ ignores), and after dropping trailing
 * dots and spaces (which NTFS ignores). A `\`, which an archive tool may make into a
 * directory, is refused in any component before this rule (`unsafePathCharacter`).
 */
const isGithubName = (component: string) => {
  if (/[~:]/.test(component)) return true
  const name = component
    .normalize("NFKC")
    .replace(invisibleCharacters, "")
    .replace(/[. ]+$/, "")
  return name.toLowerCase() === ".github" || name.toUpperCase() === ".GITHUB"
}

const checkEntry = (entry: DiffEntry): SealedResultRefused | undefined => {
  if (
    !entry.utf8 ||
    entry.path.split("/").some((part) => unsafePathCharacter.test(withoutPresentation(part)))
  )
    return refused("path_name", quoted(entry.path))
  if (!regularModes.has(entry.oldMode) || !regularModes.has(entry.newMode))
    return refused("file_mode", quoted(entry.path))
  if (entry.oldMode !== "000000" && entry.newMode !== "000000" && entry.oldMode !== entry.newMode)
    return refused("mode_change", quoted(entry.path))
  if (isGithubName(entry.path.split("/")[0]!)) return refused("github_path", quoted(entry.path))
  return undefined
}

/** Paths and modes of each commit, the changed path count and each new blob's size. */
const checkChanges = (context: GitContext, commits: ReadonlyArray<string>, base: string) =>
  Effect.gen(function* () {
    const changed = new Set<string>()
    const blobs = new Map<string, string>()
    let parent = base
    for (const commit of commits) {
      const raw = yield* gitOkBytes(context, [
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
    // The objects of the range are objects of the pack, whose count and sizes the walk
    // bounded: the bases --fix-thin adds are objects of the base.
    return commits
  })

const isCommitMessage = Schema.is(PublicationMessage)
const commitHeaders = "tree parent author committer"
const identityLine = /^(?:author|committer) (.*) <([^<>]*)> [0-9]+ [+-][0-9]{4}$/

/**
 * One commit object in the strict form of the seal: the headers tree, parent,
 * author and committer and no other (no signature, encoding or merge tag); the
 * author and the committer are the agent identity; the message passes the rules
 * of a commit message and names no blocked address.
 */
const checkCommit = (
  sha: string,
  raw: Uint8Array,
  agentGit: AgentGitConfig,
): SealedResultRefused | undefined => {
  let text: string
  try {
    text = decoder.decode(raw)
  } catch {
    return refused("commit_format", `${sha} is not UTF-8`)
  }
  const split = text.indexOf("\n\n")
  const headers = split < 0 ? [] : text.slice(0, split).split("\n")
  if (headers.map((line) => line.split(" ", 1)[0]).join(" ") !== commitHeaders)
    return refused("commit_format", `${sha} has a header other than ${commitHeaders}`)
  for (const line of headers.slice(2)) {
    const identity = identityLine.exec(line)
    if (identity?.[1] !== agentGit.name || identity[2] !== agentGit.email)
      return refused("identity", `${sha} is not by ${agentGit.name} <${agentGit.email}>`)
  }
  const message = text.slice(split + 2)
  const folded = message.toLowerCase()
  if (agentGit.blockedEmails.some((email) => folded.includes(email.toLowerCase())))
    return refused("commit_message", `${sha} names a blocked address`)
  const shown = withoutPresentation(message)
  if (controlButNewline.test(shown) || !isCommitMessage(shown))
    return refused("commit_message", `${sha} breaks the text rules of a commit message`)
  return undefined
}

/** Reads each commit of the result as a raw object and holds it to the strict form. */
const checkCommits = (
  context: GitContext,
  commits: ReadonlyArray<string>,
  agentGit: AgentGitConfig,
) =>
  Effect.gen(function* () {
    const input = new TextEncoder().encode(commits.map((sha) => `${sha}\n`).join(""))
    const sizes = (yield* gitOk(context, ["cat-file", "--batch-check=%(objectsize)"], input))
      .trim()
      .split("\n")
    const large = sizes.findIndex((size) => Number(size) > sealedResultLimits.commitBytes)
    if (large >= 0)
      return yield* refused(
        "commit_format",
        `${commits[large]} is over ${sealedResultLimits.commitBytes} bytes`,
      )
    const raw = (yield* git(context, ["cat-file", "--batch"], input)).stdout
    // Each object is `<sha> commit <size>\n<content>\n`, in the order of the input.
    let offset = 0
    for (const sha of commits) {
      const end = raw.indexOf(0x0a, offset)
      const header = new TextDecoder().decode(raw.subarray(offset, end)).split(" ")
      const size = Number(header[2])
      if (header[0] !== sha || header[1] !== "commit")
        return yield* new SealedResultFault({ operation: "cat-file", message: "Unexpected object" })
      const refusal = checkCommit(sha, raw.subarray(end + 1, end + 1 + size), agentGit)
      if (refusal !== undefined) return yield* refusal
      offset = end + 1 + size + 1
    }
  })

export type CheckedSealedResult = {
  readonly resultSha: string
  readonly target: SealedResultTarget
  readonly push: () => Effect.Effect<
    { readonly ref: string; readonly sha: string },
    SealedResultError
  >
}

/** How the daemon runs git for a check. */
export type SealedResultGitSettings = {
  /**
   * The daemon's root of scratch directories, mode 0700: each check makes its scratch
   * repository below it and removes it.
   */
  readonly scratchRoot: string
  readonly binary: string
  /** Wall clock for the whole check, and again for the push. */
  readonly timeLimitMs: number
  /** How long a check waits for a slot. */
  readonly waitLimitMs: number
  /** The protocols a remote may use. */
  readonly protocols: ReadonlyArray<SealedResultProtocol>
  /**
   * Whether a check may speak to the remote. A remote it refuses is a fault `remote`
   * before the check waits for a slot, so no token is made and no git child starts.
   */
  readonly remoteAllowed: (remote: string) => boolean
}

/**
 * The remote rule of the daemon's runner: an https URL of the GitHub host with no user
 * part and no port, in printable ASCII. The `/` right after the host leaves no place
 * for a user part, a port or another host.
 */
export const githubRemote = (remote: string) =>
  remote.startsWith(`https://${githubHost}/`) && /^[\x21-\x7e]+$/.test(remote)

export type SealedResultGitPort = {
  /**
   * Checks a sealed result in a scratch bare repository that lives as long as the
   * scope. Refuses `result_refused: <check>` when a check of the result fails, or
   * when no slot is free in time; a fault of the daemon or the remote is a
   * SealedResultFault, and a failure to make the token is the token's own error.
   */
  readonly check: <E>(
    result: SealedResult,
    target: SealedResultTarget,
    options: SealedResultOptions<E>,
  ) => Effect.Effect<CheckedSealedResult, SealedResultError | E, Scope.Scope>
}

export const SealedResultGit = Context.Service<SealedResultGitPort>("workflowd/SealedResultGit")

/**
 * Builds the git runner of the checks, which holds its scratch root for its scope: a
 * second runner on a root that a live runner holds is refused `scratch_root_held`.
 * It removes, once, what an earlier process left below the root, before any check of
 * this runner can run.
 */
export const makeSealedResultGit = (
  settings: SealedResultGitSettings,
): Effect.Effect<SealedResultGitPort, SealedResultFault, Scope.Scope> =>
  Effect.gen(function* () {
    yield* scratchRootReady(settings.scratchRoot)
    yield* holdScratchRoot(settings.scratchRoot)
    yield* removeEarlierScratch(settings.scratchRoot)
    const permits = yield* Semaphore.make(sealedResultLimits.concurrentChecks)
    // A permit is a resource of the scope of the check, held until the scratch
    // directory is gone. The acquire cannot be interrupted except in the wait for a free
    // permit, which takes none: the take and the finalizer that gives the permit back
    // are one step.
    const takePermit: Effect.Effect<void> = Effect.flatMap(permits.takeIfAvailable(1), (taken) =>
      taken
        ? Effect.void
        : Effect.andThen(Effect.interruptible(permits.withPermits(1)(Effect.void)), takePermit),
    )
    const permit = Effect.acquireRelease(takePermit, () => permits.release(1))
    // A place among the waiting checks is held while the check waits for a permit, and
    // given back when the wait ends: by a permit, the wait limit, a failure or an
    // interrupt. A check over the bound of waiting checks is refused at once.
    let waiting = 0
    const slot = Effect.acquireUseRelease(
      Effect.suspend(() => {
        if (waiting >= sealedResultLimits.waitingChecks)
          return Effect.fail(
            refused(
              "checks_waiting",
              `${waiting} checks wait for a slot; the bound is ${sealedResultLimits.waitingChecks}`,
            ),
          )
        waiting += 1
        return Effect.void
      }),
      () =>
        permit.pipe(
          Effect.timeoutOrElse({
            duration: settings.waitLimitMs,
            orElse: () =>
              Effect.fail(
                refused("wait_limit", `no slot was free within ${settings.waitLimitMs} ms`),
              ),
          }),
        ),
      () => Effect.sync(() => (waiting -= 1)),
    )
    const check = <E>(
      result: SealedResult,
      target: SealedResultTarget,
      options: SealedResultOptions<E>,
    ): Effect.Effect<CheckedSealedResult, SealedResultError | E, Scope.Scope> =>
      Effect.gen(function* () {
        if (!targetRef.test(target.ref) || target.ref.includes(".."))
          return yield* new SealedResultFault({
            operation: "target",
            message: "Invalid target ref",
          })
        if (target.expectedHead !== null && !commitId.test(target.expectedHead))
          return yield* new SealedResultFault({
            operation: "target",
            message: "Invalid expected head",
          })
        if (!settings.remoteAllowed(options.remote))
          return yield* new SealedResultFault({
            operation: "remote",
            message: "Remote is not one that the runner may speak to",
          })
        if (result.sourceSha !== options.sourceSha) return yield* refused("source")
        const base = target.expectedHead ?? options.sourceSha
        const bundle = checkBundle(result, base)
        if (bundle instanceof SealedResultRefused) return yield* bundle
        yield* slot
        yield* scratchRootReady(settings.scratchRoot)
        const scratch = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => mkdtemp(join(settings.scratchRoot, scratchPrefix)),
            catch: () =>
              new SealedResultFault({
                operation: "scratch",
                message: "Scratch directory unavailable",
              }),
          }),
          (path) =>
            Effect.promise(() =>
              rm(path, { recursive: true, force: true }).then(
                () => true,
                () => false,
              ),
            ).pipe(
              Effect.flatMap((removed) =>
                removed
                  ? Effect.void
                  : Effect.logWarning("Sealed result scratch directory remains"),
              ),
            ),
        )
        // The token is made only now that the check holds its slot.
        const token = yield* options.token
        const repository = join(scratch, "repository.git")
        const local: GitContext = {
          binary: settings.binary,
          config: gitConfig(settings.protocols),
          env: gitEnvironment(settings.protocols),
          cwd: scratch,
          scratch,
          deadline: Date.now() + settings.timeLimitMs,
          timeLimitMs: settings.timeLimitMs,
          secrets: [],
        }
        yield* gitOk(local, ["init", "--quiet", "--bare", "--template=", repository])
        const inRepository: GitContext = { ...local, cwd: repository }
        const network = networkContext(inRepository, options.remote, token)
        const offline: GitContext = { ...inRepository, secrets: network.secrets }
        const head = yield* readTarget(network, options.remote, target.ref)
        if (target.expectedHead === null && head !== null) return yield* refused("target_exists")
        if (target.expectedHead !== null && head !== target.expectedHead)
          return yield* refused("target_moved")
        yield* gitOk(network, [
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
          offline,
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
            quoted(withoutSecrets(unpack.stderr, offline.secrets).split("\n")[0]!),
          )
        const commit = yield* git(offline, ["cat-file", "-t", bundle.resultSha])
        if (commit.status !== 0 || new TextDecoder().decode(commit.stdout).trim() !== "commit")
          return yield* refused("ref", "the ref of the bundle names no commit of its pack")
        const commits = yield* checkHistory(offline, base, bundle.resultSha)
        yield* checkCommits(offline, commits, options.agentGit)
        yield* checkChanges(offline, commits, base)
        return {
          resultSha: bundle.resultSha,
          target,
          push: () =>
            pushChecked(
              { ...network, deadline: Date.now() + settings.timeLimitMs },
              options.remote,
              target,
              bundle.resultSha,
            ),
        }
      })
    return { check }
  })

/**
 * The daemon's git runner: /usr/bin/git, the time limits of the plan, and https remotes
 * of the GitHub host only.
 */
export const SealedResultGitLive = (scratchRoot: string) =>
  Layer.effect(
    SealedResultGit,
    makeSealedResultGit({
      scratchRoot,
      binary: "/usr/bin/git",
      timeLimitMs: sealedResultLimits.timeLimitMs,
      waitLimitMs: sealedResultLimits.waitLimitMs,
      protocols: ["https"],
      remoteAllowed: githubRemote,
    }),
  )

/** Checks a sealed result with the daemon's git runner; see `SealedResultGitPort.check`. */
export const checkSealedResult = <E>(
  result: SealedResult,
  target: SealedResultTarget,
  options: SealedResultOptions<E>,
): Effect.Effect<CheckedSealedResult, SealedResultError | E, Scope.Scope | SealedResultGitPort> =>
  Effect.gen(function* () {
    const runner = yield* SealedResultGit
    return yield* runner.check(result, target, options)
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
