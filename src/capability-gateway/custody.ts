import { randomUUID } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import { dlopen, FFIType } from "bun:ffi"
import { Schema } from "effect"

/**
 * Custody of the gateway's provider login. The login is one file of the gateway's uid, mode 0600,
 * in a directory of the gateway's uid, mode 0700. It comes in only through `import-login`, on
 * standard input, and leaves only as a short-lived access value on the noscope provider
 * `provider-access`, which renews it on demand. No value is in an error text or a log line.
 */

/** The largest login that custody imports or reads, in bytes. */
export const loginLimit = 16384
/** The time limit of one request to the OAuth server. */
export const renewalLimitMs = 5000
/** A login whose access value has this long or less to live is renewed before it is used. */
const renewWithinMs = 60000
/** How long a call waits for another call that holds the login. */
const lockWaitMs = 15000

/** The fields of an object of the login's document; none of anything else. */
const fields = (value: unknown): object =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value : {}

const OAuth = Schema.Struct({
  accessToken: Schema.NonEmptyString.check(Schema.isMaxLength(8192)),
  refreshToken: Schema.NonEmptyString.check(Schema.isMaxLength(8192)),
  expiresAt: Schema.Int,
  scopes: Schema.Array(Schema.String),
})
type OAuth = typeof OAuth.Type
const ClaudeDocument = Schema.Struct({ claudeAiOauth: OAuth })
const ClaudeRenewal = Schema.Struct({
  access_token: Schema.NonEmptyString.check(Schema.isMaxLength(8192)),
  refresh_token: Schema.NonEmptyString.check(Schema.isMaxLength(8192)),
  expires_in: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86400 })),
  scope: Schema.String,
})

/**
 * The providers whose login custody holds, one entry each: where the login is renewed, and how
 * its document holds the OAuth values. Codex comes with its adapter.
 */
const providers = {
  claude: {
    tokenUrl: "https://platform.claude.com/v1/oauth/token",
    /** Claude Code's public OAuth client. */
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    read: (document: unknown): OAuth =>
      Schema.decodeUnknownSync(ClaudeDocument)(document).claudeAiOauth,
    /** The document with renewed values; its other fields stay as imported. */
    write: (document: Record<string, unknown>, next: OAuth) => ({
      ...document,
      claudeAiOauth: { ...fields(document.claudeAiOauth), ...next },
    }),
    renewed: (answer: unknown, now: number): OAuth => {
      const value = Schema.decodeUnknownSync(ClaudeRenewal)(answer)
      return {
        accessToken: value.access_token,
        refreshToken: value.refresh_token,
        expiresAt: now + value.expires_in * 1000,
        scopes: value.scope.split(" "),
      }
    },
  },
} as const
export type CustodyProvider = keyof typeof providers
export const custodyProvider = (name: string): CustodyProvider | undefined =>
  Object.keys(providers).find((key): key is CustodyProvider => key === name)

/** A path of the login that custody does not use; the message names the path and the fault. */
export class CustodyRefused extends Error {}
/** The login cannot be used now; a later call may succeed. */
export class CustodyUnavailable extends Error {}

/** Why a login no longer renews. */
export type ImportReason = "refused" | "unanswered" | "interrupted"
const reasons: Record<ImportReason, string> = {
  refused: "the OAuth server refused its renewal",
  unanswered: `its renewal got no answer within ${renewalLimitMs / 1000} seconds`,
  interrupted: "a renewal stopped before its answer was stored",
}
/** The typed state of a login that only a new `import-login` brings back. */
export class LoginImportRequired extends Error {
  constructor(
    readonly provider: CustodyProvider,
    readonly reason: ImportReason,
  ) {
    super(`the ${provider} login needs a new import: ${reasons[reason]}`)
  }
}

/**
 * The state of a login beside it. `renewing` is written before a request to the OAuth server and
 * removed once its answer is stored: seen by the next call, it means the request may have used
 * the refresh value with no record of the answer.
 */
const State = Schema.Union([
  Schema.Struct({ state: Schema.Literal("renewing") }),
  Schema.Struct({
    state: Schema.Literal("import-required"),
    reason: Schema.Literals(["refused", "unanswered", "interrupted"]),
  }),
])

const octal = (mode: number) => (mode & 0o777).toString(8).padStart(4, "0")
const uid = () => {
  const value = process.getuid?.()
  if (value === undefined) throw new CustodyRefused("custody refused: no uid")
  return value
}
const absent = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT"

/** The fault of a path that custody does not use, or undefined. */
function fault(info: Stats, kind: "directory" | "file") {
  const mode = kind === "directory" ? 0o700 : 0o600
  if (kind === "directory" ? !info.isDirectory() : !info.isFile()) return `not a ${kind}`
  if (info.uid !== uid()) return `owner uid ${info.uid}, custody requires uid ${uid()}`
  if ((info.mode & 0o777) !== mode)
    return `mode ${octal(info.mode)}, custody requires ${octal(mode)}`
  if (kind === "file" && info.nlink !== 1) return `${info.nlink} links, custody requires 1`
  if (kind === "file" && info.size > loginLimit)
    return `longer than ${loginLimit} bytes, custody allows ${loginLimit}`
  return undefined
}
const refuse = (path: string, info: Stats, kind: "directory" | "file") => {
  const found = fault(info, kind)
  if (found) throw new CustodyRefused(`custody refused ${path}: ${found}`)
}

const loginPath = (directory: string, provider: CustodyProvider) =>
  join(directory, `${provider}.json`)
const statePath = (directory: string, provider: CustodyProvider) =>
  join(directory, `${provider}.state`)

/** The text of a private file of custody, or undefined when there is none. */
async function readPrivate(path: string) {
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (absent(error)) return undefined
    if (error instanceof Error && "code" in error && error.code === "ELOOP")
      throw new CustodyRefused(`custody refused ${path}: a symbolic link`)
    throw error
  }
  try {
    refuse(path, await file.stat(), "file")
    return await file.readFile("utf8")
  } finally {
    await file.close()
  }
}

/** Writes `text` to `path` whole: a new file of mode 0600, a sync, one rename, a sync. */
async function persist(directory: string, path: string, text: string) {
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, "wx", 0o600)
  try {
    await file.writeFile(text)
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(temporary, path)
  await syncDirectory(directory)
}
async function syncDirectory(directory: string) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
async function remove(directory: string, path: string) {
  await unlink(path).catch((error: unknown) => {
    if (!absent(error)) throw error
  })
  await syncDirectory(directory)
}

/** Refuses the directory and the login of `provider` when either has another owner or a wider mode. */
export async function checkLogin(directory: string, provider: CustodyProvider) {
  const info = await lstat(directory).catch((error: unknown) => {
    if (absent(error)) return undefined
    throw error
  })
  if (!info) return
  refuse(directory, info, "directory")
  const file = await lstat(loginPath(directory, provider)).catch((error: unknown) => {
    if (absent(error)) return undefined
    throw error
  })
  if (file) refuse(loginPath(directory, provider), file, "file")
}

/**
 * Why the login of `provider` cannot be used, as a line without any value; undefined when no
 * fault is known. The gateway logs it when a call finds no access value.
 */
export async function loginFault(directory: string, provider: CustodyProvider) {
  try {
    await checkLogin(directory, provider)
    const text = await readPrivate(statePath(directory, provider))
    const state = text === undefined ? undefined : Schema.decodeUnknownSync(State)(JSON.parse(text))
    if (state?.state === "import-required")
      return `custody: ${new LoginImportRequired(provider, state.reason).message}`
    return undefined
  } catch (error) {
    return error instanceof CustodyRefused ? error.message : undefined
  }
}

/**
 * Runs `body` while this process holds the login of `provider`, after the directory is checked.
 * The lock is an advisory lock on a file of its own; temporary files of a stopped write are
 * removed first.
 */
async function holding<A>(directory: string, provider: CustodyProvider, body: () => Promise<A>) {
  const info = await lstat(directory).catch((error: unknown) => {
    if (absent(error)) throw new CustodyRefused(`custody refused ${directory}: no login imported`)
    throw error
  })
  refuse(directory, info, "directory")
  const path = join(directory, `${provider}.lock`)
  const lock = await open(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  )
  const libc = dlopen("libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  })
  try {
    refuse(path, await lock.stat(), "file")
    const until = Date.now() + lockWaitMs
    // LOCK_EX | LOCK_NB, so that a wait never blocks the process past its limit.
    while (libc.symbols.flock(lock.fd, 2 | 4) !== 0) {
      if (Date.now() > until) throw new CustodyUnavailable(`the ${provider} login is busy`)
      await Bun.sleep(25)
    }
    for (const name of await readdir(directory))
      if (name.startsWith(`${provider}.`) && name.endsWith(".tmp"))
        await unlink(join(directory, name))
    return await body()
  } finally {
    await lock.close()
    libc.close()
  }
}

/** Why `import-login` refuses its input; the message holds no part of it. */
export class ImportRefused extends Error {}

/**
 * Imports the login of `provider` from `input`, which `import-login` read on standard input. A
 * login that is there already is replaced whole, and a state that asked for a new import ends.
 */
export async function importLogin(directory: string, provider: CustodyProvider, input: Buffer) {
  if (input.length > loginLimit)
    throw new ImportRefused(`the login is longer than ${loginLimit} bytes`)
  let document: Record<string, unknown>
  let oauth: OAuth
  try {
    document = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
      JSON.parse(input.toString("utf8")),
    )
    oauth = providers[provider].read(document)
  } catch {
    throw new ImportRefused("the login does not parse")
  }
  if (!oauth.scopes.includes("user:inference"))
    throw new ImportRefused("the login does not hold the scope user:inference")
  await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
  })
  return await holding(directory, provider, async () => {
    const path = loginPath(directory, provider)
    const existed = await lstat(path).then(
      () => true,
      (error: unknown) => {
        if (absent(error)) return false
        throw error
      },
    )
    await persist(directory, path, JSON.stringify(document))
    await remove(directory, statePath(directory, provider))
    return existed ? ("replaced" as const) : ("imported" as const)
  })
}

/** An access value and when it ends. */
export interface Access {
  readonly token: string
  readonly expiresAt: number
}

const loopback = new Set(["127.0.0.1", "[::1]", "localhost"])
/** The token URL of a renewal: HTTPS, or plain HTTP to loopback only (a fixture server). */
export function tokenUrl(provider: CustodyProvider, override?: string) {
  if (override === undefined) return providers[provider].tokenUrl
  const url = new URL(override)
  if (url.protocol === "https:" || (url.protocol === "http:" && loopback.has(url.hostname)))
    return url.href
  throw new CustodyRefused("refused")
}

/** The OAuth server's answer, read to at most 16 KiB. */
async function answer(response: Response) {
  if (!response.body) throw new Error("no answer body")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const part = await reader.read()
    if (part.done) break
    const chunk: unknown = part.value
    if (!(chunk instanceof Uint8Array)) throw new Error("answer refused")
    size += chunk.length
    if (size > 16384) {
      await reader.cancel()
      throw new Error("answer too long")
    }
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
}

/**
 * The access value of the login of `provider`, renewed first when it ends within a minute. Calls
 * at one time wait for each other, so one renewal serves them all. The renewed login is on disk
 * before its access value is returned.
 */
export async function access(
  directory: string,
  provider: CustodyProvider,
  url: string,
): Promise<Access> {
  return await holding(directory, provider, async () => {
    const statePathOf = statePath(directory, provider)
    const stateText = await readPrivate(statePathOf)
    if (stateText !== undefined) {
      const state = Schema.decodeUnknownSync(State)(JSON.parse(stateText))
      const reason = state.state === "renewing" ? "interrupted" : state.reason
      if (state.state === "renewing")
        await persist(directory, statePathOf, JSON.stringify({ state: "import-required", reason }))
      throw new LoginImportRequired(provider, reason)
    }
    const path = loginPath(directory, provider)
    const text = await readPrivate(path)
    if (text === undefined) throw new CustodyRefused(`custody refused ${path}: no login imported`)
    const document = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
      JSON.parse(text),
    )
    const oauth = providers[provider].read(document)
    if (oauth.expiresAt > Date.now() + renewWithinMs)
      return { token: oauth.accessToken, expiresAt: oauth.expiresAt }
    const required = async (reason: ImportReason) => {
      await persist(directory, statePathOf, JSON.stringify({ state: "import-required", reason }))
      return new LoginImportRequired(provider, reason)
    }
    // From here the OAuth server may take the refresh value: a stop leaves `renewing`.
    await persist(directory, statePathOf, JSON.stringify({ state: "renewing" }))
    const signal = AbortSignal.timeout(renewalLimitMs)
    let next: OAuth
    try {
      const response = await fetch(url, {
        method: "POST",
        redirect: "error",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: oauth.refreshToken,
          client_id: providers[provider].clientId,
        }),
      })
      if ([400, 401, 403].includes(response.status)) {
        await response.body?.cancel()
        throw await required("refused")
      }
      if (!response.ok) {
        // The server answered and did not renew: the refresh value is as it was.
        await response.body?.cancel()
        await remove(directory, statePathOf)
        throw new CustodyUnavailable(`the OAuth server of ${provider} answered ${response.status}`)
      }
      next = providers[provider].renewed(await answer(response), Date.now())
    } catch (error) {
      if (error instanceof LoginImportRequired || error instanceof CustodyUnavailable) throw error
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ConnectionRefused" || error.code === "ECONNREFUSED")
      ) {
        // No connection, so no request: the refresh value is as it was.
        await remove(directory, statePathOf)
        throw new CustodyUnavailable(`the OAuth server of ${provider} is not reachable`)
      }
      throw await required(signal.aborted ? "unanswered" : "interrupted")
    }
    if (!next.scopes.includes("user:inference") || next.expiresAt <= Date.now())
      throw await required("interrupted")
    await persist(directory, path, JSON.stringify(providers[provider].write(document, next)))
    await remove(directory, statePathOf)
    return { token: next.accessToken, expiresAt: next.expiresAt }
  })
}

/**
 * The noscope provider command: `access <directory> [--token-url <url>] <provider> <ttl>`. It
 * prints the access value as noscope's provider contract asks, or throws.
 */
export async function custodyCommand(args: ReadonlyArray<string>) {
  const [operation, directory, ...rest] = args
  const override = rest[0] === "--token-url" ? rest[1] : undefined
  const [name, ttlText, ...extra] = override === undefined ? rest : rest.slice(2)
  const provider = custodyProvider(name ?? "")
  const ttl = Number(ttlText)
  if (
    operation !== "access" ||
    !directory?.startsWith("/") ||
    !provider ||
    extra.length > 0 ||
    !Number.isInteger(ttl) ||
    ttl < 1 ||
    ttl > 3600
  )
    throw new CustodyRefused("refused")
  const value = await access(directory, provider, tokenUrl(provider, override))
  return {
    token: value.token,
    token_id: randomUUID(),
    expires_at: new Date(Math.min(value.expiresAt, Date.now() + ttl * 1000)).toISOString(),
  }
}

/** The line of standard error for a failed command; it names no value. */
export const custodyFailure = (error: unknown) =>
  `custody: ${
    error instanceof LoginImportRequired ||
    error instanceof CustodyUnavailable ||
    error instanceof CustodyRefused
      ? error.message
      : "refused"
  }\n`

// Noscope starts the command in its own process group: parent-death signaling ends it with
// noscope, and it refuses to run when its parent is gone.
if (import.meta.main) {
  const parent = process.ppid
  const libc = dlopen("libc.so.6", {
    prctl: {
      args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
      returns: FFIType.i32,
    },
  })
  // PR_SET_PDEATHSIG, SIGKILL
  const attached = parent > 1 && libc.symbols.prctl(1, 9, 0, 0, 0) === 0 && process.ppid === parent
  libc.close()
  try {
    if (!attached) throw new CustodyRefused("refused")
    process.stdout.write(JSON.stringify(await custodyCommand(process.argv.slice(2))))
  } catch (error) {
    process.stderr.write(custodyFailure(error))
    process.exitCode = 1
  }
}
