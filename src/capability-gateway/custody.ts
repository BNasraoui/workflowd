import { randomUUID } from "node:crypto"
import { constants, type Stats } from "node:fs"
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises"
import { dirname, join } from "node:path"
import { dlopen, FFIType, ptr } from "bun:ffi"
import { Schema } from "effect"

/**
 * Custody of the gateway's provider login. The login is one file of the gateway's uid, mode 0600,
 * in a directory of the gateway's uid, mode 0700. It comes in only through `import-login`, on
 * standard input, and leaves only as a short-lived access value on the noscope provider
 * `provider-access`, which renews it on demand. No value is in an error text or a log line.
 *
 * Only a refusal of the OAuth server (400 `invalid_grant`, RFC 6749 section 5.2) makes the login
 * need a new import. Any other answer, and any fault, leaves the stored login as it was, and the
 * next try waits: `firstRetryWaitMs`, doubled for each failed try, at most `retryWaitCapMs`.
 */

/** The largest login that custody imports or reads, in bytes. */
export const loginLimit = 16384
/** The time limit of one request to the OAuth server. */
const renewalLimitMs = 5000
/** A login whose access value has this long or less to live is renewed before it is used. */
const renewWithinMs = 60000
/** How long a call waits for another call that holds the login. */
const lockWaitMs = 15000
/** The wait after the first failed try of a renewal; each later failed try doubles it. */
const firstRetryWaitMs = 5000
/** The longest wait between two tries, a longer `Retry-After` of the server included. */
const retryWaitCapMs = 300000
/** The scope that a model call needs. */
const inferenceScope = "user:inference"

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
const Document = Schema.Record(Schema.String, Schema.Json)
const ClaudeDocument = Schema.Struct({ claudeAiOauth: OAuth })
const ClaudeRenewal = Schema.Struct({
  access_token: Schema.NonEmptyString.check(Schema.isMaxLength(8192)),
  refresh_token: Schema.NonEmptyString.check(Schema.isMaxLength(8192)),
  expires_in: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86400 })),
  // RFC 6749 section 5.1: a server may leave the scope out when it did not change.
  scope: Schema.optionalKey(Schema.String),
})
const OAuthError = Schema.Struct({ error: Schema.String })

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
    renewed: (answer: unknown, now: number, scopes: ReadonlyArray<string>): OAuth => {
      const value = Schema.decodeUnknownSync(ClaudeRenewal)(answer)
      return {
        accessToken: value.access_token,
        refreshToken: value.refresh_token,
        expiresAt: now + value.expires_in * 1000,
        scopes: value.scope === undefined ? scopes : value.scope.split(" "),
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
class CustodyUnavailable extends Error {}
/** The OAuth server refused the renewal value: only a new `import-login` brings the login back. */
class LoginImportRequired extends Error {
  constructor(provider: CustodyProvider) {
    super(`the ${provider} login needs a new import: the OAuth server refused its renewal value`)
  }
}
/** The stored login lacks the scope of a model call; its values are kept. */
class LoginScopeMissing extends Error {
  constructor(provider: CustodyProvider) {
    super(`the ${provider} login does not hold the scope ${inferenceScope}`)
  }
}

/**
 * The state of a login beside it. `renewing` is written before a request to the OAuth server and
 * removed once a renewal is stored. Seen by a later call it means: the stored refresh value is
 * sent again, not before `retryAt`, after `failures` failed tries. A stop during the request
 * leaves it with no wait.
 */
const State = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("renewing"),
    failures: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 64 })),
    retryAt: Schema.Number,
  }),
  Schema.Struct({ state: Schema.Literal("import-required") }),
])
type State = typeof State.Type

const octal = (mode: number) => (mode & 0o777).toString(8).padStart(4, "0")
const uid = () => {
  const value = process.getuid?.()
  if (value === undefined) throw new CustodyRefused("custody refused: no uid")
  return value
}
const code = (error: unknown) =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
const absent = (error: unknown) => code(error) === "ENOENT"

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

/**
 * The login directory, opened once. Each check and open of its files goes through the open
 * directory (`/proc/self/fd/<fd>/<name>`), so a rename or a symbolic link put in place of its path
 * after the check changes nothing.
 */
interface Directory {
  readonly path: string
  readonly handle: FileHandle
  /** The path of `name` in the open directory. */
  readonly at: (name: string) => string
}

/** The open login directory of `path`, after its checks; undefined when there is none. */
async function openDirectory(path: string): Promise<Directory | undefined> {
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  } catch (error) {
    if (absent(error)) return undefined
    if (code(error) === "ELOOP" || code(error) === "ENOTDIR")
      throw new CustodyRefused(`custody refused ${path}: not a directory`)
    // A directory that this user cannot open has a fault that its owner or mode names.
    if (code(error) === "EACCES") refuse(path, await lstat(path), "directory")
    throw error
  }
  try {
    refuse(path, await handle.stat(), "directory")
  } catch (error) {
    await handle.close()
    throw error
  }
  return { path, handle, at: (name) => `/proc/self/fd/${handle.fd}/${name}` }
}
async function withDirectory<A>(path: string, body: (directory: Directory) => Promise<A>) {
  const directory = await openDirectory(path)
  if (!directory) throw new CustodyRefused(`custody refused ${path}: no login imported`)
  try {
    return await body(directory)
  } finally {
    await directory.handle.close()
  }
}

const loginName = (provider: CustodyProvider) => `${provider}.json`
const stateName = (provider: CustodyProvider) => `${provider}.state`

/** The text of a private file of custody in `directory`, or undefined when there is none. */
async function readPrivate(directory: Directory, name: string) {
  const path = join(directory.path, name)
  let file
  try {
    file = await open(
      directory.at(name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
  } catch (error) {
    if (absent(error)) return undefined
    if (code(error) === "ELOOP")
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

/** Writes `text` to `name` whole: a new file of mode 0600, a sync, one rename, a sync. */
async function persist(directory: Directory, name: string, text: string) {
  const temporary = `${name}.${randomUUID()}.tmp`
  const file = await open(directory.at(temporary), "wx", 0o600)
  try {
    await file.writeFile(text)
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(directory.at(temporary), directory.at(name))
  await directory.handle.sync()
}
async function remove(directory: Directory, name: string) {
  await unlink(directory.at(name)).catch((error: unknown) => {
    if (!absent(error)) throw error
  })
  await directory.handle.sync()
}

const readState = async (directory: Directory, provider: CustodyProvider) => {
  const text = await readPrivate(directory, stateName(provider))
  return text === undefined ? undefined : Schema.decodeUnknownSync(State)(JSON.parse(text))
}
const writeState = (directory: Directory, provider: CustodyProvider, state: State) =>
  persist(directory, stateName(provider), JSON.stringify(state))

/** The stored login of `provider`: its document and its OAuth values. */
async function readLogin(directory: Directory, provider: CustodyProvider) {
  const text = await readPrivate(directory, loginName(provider))
  if (text === undefined)
    throw new CustodyRefused(
      `custody refused ${join(directory.path, loginName(provider))}: no login imported`,
    )
  const document = Schema.decodeUnknownSync(Document)(JSON.parse(text))
  return { document, oauth: providers[provider].read(document) }
}

/** Refuses the directory and the login of `provider` when either has another owner or a wider mode. */
export async function checkLogin(path: string, provider: CustodyProvider) {
  const directory = await openDirectory(path)
  if (!directory) return
  try {
    await readPrivate(directory, loginName(provider))
  } finally {
    await directory.handle.close()
  }
}

/**
 * Why the login of `provider` cannot be used, as a line without any value; undefined when no
 * fault is known. The gateway logs it when a call finds no access value.
 */
export async function loginFault(path: string, provider: CustodyProvider) {
  try {
    return await withDirectory(path, async (directory) => {
      const state = await readState(directory, provider)
      if (state?.state === "import-required")
        return `custody: ${new LoginImportRequired(provider).message}`
      const { oauth } = await readLogin(directory, provider)
      if (!oauth.scopes.includes(inferenceScope))
        return `custody: ${new LoginScopeMissing(provider).message}`
      if (state && state.retryAt > Date.now())
        return `custody: the ${provider} login was not renewed; custody waits before it asks the OAuth server again`
      return undefined
    })
  } catch (error) {
    return error instanceof CustodyRefused ? error.message : undefined
  }
}

/**
 * Runs `body` while this process holds the login of `provider`, in its open directory. The lock
 * is an advisory lock on a file of its own.
 */
async function holding<A>(
  path: string,
  provider: CustodyProvider,
  body: (directory: Directory) => Promise<A>,
) {
  return await withDirectory(path, async (directory) => {
    const name = `${provider}.lock`
    const lock = await open(
      directory.at(name),
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    )
    const libc = dlopen("libc.so.6", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    })
    try {
      refuse(join(path, name), await lock.stat(), "file")
      const until = Date.now() + lockWaitMs
      // LOCK_EX | LOCK_NB, so that a wait never blocks the process past its limit.
      while (libc.symbols.flock(lock.fd, 2 | 4) !== 0) {
        if (Date.now() > until) throw new CustodyUnavailable(`the ${provider} login is busy`)
        await Bun.sleep(25)
      }
      return await body(directory)
    } finally {
      await lock.close()
      libc.close()
    }
  })
}

/** The temporary files of a stopped write of `provider`'s files. */
const temporaries = async (directory: Directory, provider: CustodyProvider) =>
  (await readdir(directory.at(""))).filter(
    (name) => name.startsWith(`${provider}.`) && name.endsWith(".tmp"),
  )
async function clearTemporaries(directory: Directory, provider: CustodyProvider) {
  for (const name of await temporaries(directory, provider))
    await unlink(directory.at(name)).catch((error: unknown) => {
      if (!absent(error)) throw error
    })
}

/**
 * After a stop during a renewal: the complete temporary login that the stop left, when one parses
 * and ends later than the stored login, becomes the login, renamed and synced as a write is.
 */
async function recover(directory: Directory, provider: CustodyProvider, stored: OAuth) {
  let best: { readonly name: string; readonly oauth: OAuth } | undefined
  for (const name of await temporaries(directory, provider)) {
    if (!name.startsWith(`${loginName(provider)}.`)) continue
    try {
      const text = await readPrivate(directory, name)
      if (text === undefined) continue
      const oauth = providers[provider].read(Schema.decodeUnknownSync(Document)(JSON.parse(text)))
      if (oauth.expiresAt > (best?.oauth ?? stored).expiresAt) best = { name, oauth }
    } catch {
      // An incomplete or foreign file is not a login.
    }
  }
  if (!best) return false
  await rename(directory.at(best.name), directory.at(loginName(provider)))
  await directory.handle.sync()
  return true
}

/** Why `import-login` refuses its input; the message holds no part of it. */
export class ImportRefused extends Error {}

/**
 * Imports the login of `provider` from `input`, which `import-login` read on standard input. A
 * login that is there already is replaced whole, and a state of the old one ends. The command
 * runs as the gateway's user: not root, and the owner of the directory, or of its parent when
 * the directory is not there yet. It makes nothing when it refuses.
 */
export async function importLogin(path: string, provider: CustodyProvider, input: Buffer) {
  if (input.length > loginLimit)
    throw new ImportRefused(`the login is longer than ${loginLimit} bytes`)
  let document: Record<string, unknown>
  let oauth: OAuth
  try {
    document = Schema.decodeUnknownSync(Document)(JSON.parse(input.toString("utf8")))
    oauth = providers[provider].read(document)
  } catch {
    throw new ImportRefused("the login does not parse")
  }
  if (!oauth.scopes.includes(inferenceScope))
    throw new ImportRefused(`the login does not hold the scope ${inferenceScope}`)
  if (uid() === 0) throw new ImportRefused("import-login runs as the gateway's user, not as root")
  const exists = await lstat(path).then(
    () => true,
    (error: unknown) => {
      if (absent(error)) return false
      throw error
    },
  )
  if (!exists) {
    const parent = dirname(path)
    const owner = (await lstat(parent)).uid
    if (owner !== uid())
      throw new ImportRefused(
        `${parent} belongs to uid ${owner}: import-login runs as the gateway's user, which owns it`,
      )
    await mkdir(path, { mode: 0o700 })
    // 0700 whatever the umask, as the gateway requires at start.
    await chmod(path, 0o700)
  }
  return await holding(path, provider, async (directory) => {
    const existed = await lstat(directory.at(loginName(provider))).then(
      () => true,
      (error: unknown) => {
        if (absent(error)) return false
        throw error
      },
    )
    await clearTemporaries(directory, provider)
    await persist(directory, loginName(provider), JSON.stringify(document))
    await remove(directory, stateName(provider))
    return existed ? ("replaced" as const) : ("imported" as const)
  })
}

const loopback = new Set(["127.0.0.1", "[::1]", "localhost"])
/** The token URL of a renewal: HTTPS, or plain HTTP to loopback only (a fixture server). */
function tokenUrl(provider: CustodyProvider, override?: string) {
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

/** The wait that a `Retry-After` header asks for, in milliseconds, or 0. */
function retryAfter(response: Response, now: number) {
  const value = response.headers.get("retry-after")?.trim() ?? ""
  if (/^\d{1,9}$/.test(value)) return Number(value) * 1000
  const date = Date.parse(value)
  return Number.isNaN(date) ? 0 : Math.max(0, date - now)
}

/** The outcome of one request to the OAuth server. */
type Renewal =
  | { readonly kind: "renewed"; readonly next: OAuth }
  | { readonly kind: "refused" }
  | { readonly kind: "failed"; readonly cause: string; readonly askedWaitMs: number }

/** One request with the refresh value of `stored`; no fault escapes it. */
async function renew(provider: CustodyProvider, url: string, stored: OAuth): Promise<Renewal> {
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(renewalLimitMs),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: stored.refreshToken,
        client_id: providers[provider].clientId,
      }),
    })
    const now = Date.now()
    if (response.status === 400) {
      const body = Schema.decodeUnknownOption(OAuthError)(await answer(response).catch(() => null))
      if (body._tag === "Some" && body.value.error === "invalid_grant") return { kind: "refused" }
      return { kind: "failed", cause: "answered 400", askedWaitMs: 0 }
    }
    if (!response.ok) {
      await response.body?.cancel()
      return {
        kind: "failed",
        cause: `answered ${response.status}`,
        askedWaitMs: retryAfter(response, now),
      }
    }
    return {
      kind: "renewed",
      next: providers[provider].renewed(await answer(response), now, stored.scopes),
    }
  } catch (error) {
    // No answer, or one that does not parse: DNS, TLS, a refused or reset connection, the limit.
    return {
      kind: "failed",
      cause:
        error instanceof Error && error.name === "TimeoutError"
          ? `gave no answer within ${renewalLimitMs / 1000} seconds`
          : "gave no answer that custody reads",
      askedWaitMs: 0,
    }
  }
}

/** The access value and its end, after the scope check. */
function usable(provider: CustodyProvider, oauth: OAuth) {
  if (!oauth.scopes.includes(inferenceScope)) throw new LoginScopeMissing(provider)
  return { token: oauth.accessToken, expiresAt: oauth.expiresAt }
}

/**
 * The access value of the login of `provider`, renewed first when it ends within a minute or a
 * renewal was not finished. Calls at one time wait for each other, so one renewal serves them
 * all. The renewed login is on disk before its access value is returned.
 */
async function access(path: string, provider: CustodyProvider, url: string) {
  return await holding(path, provider, async (directory) => {
    let state = await readState(directory, provider)
    if (state?.state === "import-required") throw new LoginImportRequired(provider)
    let { document, oauth } = await readLogin(directory, provider)
    if (state && (await recover(directory, provider, oauth))) {
      ;({ document, oauth } = await readLogin(directory, provider))
      await remove(directory, stateName(provider))
      state = undefined
    }
    await clearTemporaries(directory, provider)
    if (!state && oauth.expiresAt > Date.now() + renewWithinMs) return usable(provider, oauth)
    if (state && state.retryAt > Date.now())
      throw new CustodyUnavailable(
        `the ${provider} login waits to renew until ${new Date(state.retryAt).toISOString()}`,
      )
    const failures = state?.failures ?? 0
    // From here the OAuth server may take the refresh value: a stop leaves `renewing`.
    await writeState(directory, provider, { state: "renewing", failures, retryAt: 0 })
    const outcome = await renew(provider, url, oauth)
    if (outcome.kind === "refused") {
      await writeState(directory, provider, { state: "import-required" })
      throw new LoginImportRequired(provider)
    }
    if (outcome.kind === "failed") {
      const wait = Math.min(
        retryWaitCapMs,
        Math.max(firstRetryWaitMs * 2 ** Math.min(failures, 16), outcome.askedWaitMs),
      )
      const retryAt = Date.now() + wait
      await writeState(directory, provider, {
        state: "renewing",
        failures: Math.min(failures + 1, 64),
        retryAt,
      })
      throw new CustodyUnavailable(
        `the OAuth server of ${provider} ${outcome.cause}; no request before ${new Date(retryAt).toISOString()}`,
      )
    }
    // The server has replaced the refresh value: the new values are stored whatever their scope.
    const next = outcome.next
    await persist(
      directory,
      loginName(provider),
      JSON.stringify(providers[provider].write(document, next)),
    )
    await remove(directory, stateName(provider))
    return usable(provider, next)
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
const custodyFailure = (error: unknown) =>
  `custody: ${
    error instanceof LoginImportRequired ||
    error instanceof LoginScopeMissing ||
    error instanceof CustodyUnavailable ||
    error instanceof CustodyRefused
      ? error.message
      : "refused"
  }\n`

/**
 * This process writes no core file: its core limit is 0, which the processes it starts inherit,
 * and it is not dumpable. Custody and the gateway hold login values in memory.
 */
export function forbidCoreFiles() {
  const libc = dlopen("libc.so.6", {
    setrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    prctl: {
      args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
      returns: FFIType.i32,
    },
  })
  try {
    // RLIMIT_CORE, soft and hard 0; PR_SET_DUMPABLE, 0.
    const limit = new BigUint64Array([0n, 0n])
    if (libc.symbols.setrlimit(4, ptr(limit)) !== 0 || libc.symbols.prctl(4, 0, 0, 0, 0) !== 0)
      throw new Error("the core file limit was not set")
  } finally {
    libc.close()
  }
}

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
    forbidCoreFiles()
    process.stdout.write(JSON.stringify(await custodyCommand(process.argv.slice(2))))
  } catch (error) {
    process.stderr.write(custodyFailure(error))
    process.exitCode = 1
  }
}
