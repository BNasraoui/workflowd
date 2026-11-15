import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { open, rename, unlink, lstat } from "node:fs/promises"
import { dlopen, FFIType } from "bun:ffi"
import { Schema } from "effect"
import { credentialParent } from "./credentials"

const OAuth = Schema.Struct({
  accessToken: Schema.NonEmptyString.check(Schema.isMaxLength(8192)),
  refreshToken: Schema.NonEmptyString.check(Schema.isMaxLength(8192)),
  expiresAt: Schema.Int,
  scopes: Schema.Array(Schema.String),
  accountId: Schema.optionalKey(Schema.NonEmptyString),
  idToken: Schema.optionalKey(Schema.NonEmptyString),
})
type OAuth = typeof OAuth.Type
export interface ProviderSnapshot {
  readonly token: string
  readonly expiresAt: number
}
export interface ProviderAccessOwner {
  readonly snapshot: () => Promise<ProviderSnapshot>
}
export interface ProviderOwnerConfiguration {
  readonly kind?: "claude" | "codex" | "api-key"
  readonly canonical: string
  readonly ownerUid: number
  readonly groupGid: number
}
export type ProviderRefresh = (previous: OAuth, signal: AbortSignal) => Promise<OAuth | null>

const CodexTokens = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
  id_token: Schema.NonEmptyString,
  account_id: Schema.NonEmptyString,
})
// Expiry is a conservative bound on an already-custodied credential, not JWT
// authentication or authority supplied by a worker.
function codexExpiry(token: string) {
  const payload = token.split(".")[1]
  if (!payload || payload.length > 16384) throw new Error("provider custody unavailable")
  const value = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ exp: Schema.Int })))(
    Buffer.from(payload, "base64url").toString("utf8"),
  )
  return value.exp * 1000
}

export const refreshCodexAccess =
  (clientId: string, send: RefreshTransport = fetch): ProviderRefresh =>
  async (previous, signal) => {
    if (!clientId || clientId.length > 256 || !previous.accountId || !previous.idToken)
      throw new Error("provider request refused")
    const response = await send("https://auth.openai.com/oauth/token", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      tls: { rejectUnauthorized: true },
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: previous.refreshToken,
        client_id: clientId,
      }),
    })
    if (response.status === 429) {
      await response.body?.cancel()
      return null
    }
    if (!response.ok || !response.body) throw new Error("provider custody uncertain")
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of response.body) {
      if (!(chunk instanceof Uint8Array)) throw new Error("provider custody uncertain")
      size += chunk.length
      if (size > 16384) throw new Error("provider custody uncertain")
      chunks.push(chunk)
    }
    const next = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          access_token: Schema.NonEmptyString,
          refresh_token: Schema.optionalKey(Schema.NonEmptyString),
          id_token: Schema.optionalKey(Schema.NonEmptyString),
        }),
      ),
    )(Buffer.concat(chunks).toString("utf8"))
    return {
      ...previous,
      accessToken: next.access_token,
      refreshToken: next.refresh_token ?? previous.refreshToken,
      idToken: next.id_token ?? previous.idToken,
      expiresAt: codexExpiry(next.access_token),
    }
  }

/** Native OAuth rotation only. This never creates or falls back to a Console/API key. */
type RefreshTransport = (
  url: string,
  request: RequestInit & { tls: { rejectUnauthorized: true } },
) => Promise<Response>
export const refreshClaudeAccess =
  (clientId: string, send: RefreshTransport = fetch): ProviderRefresh =>
  async (previous, signal) => {
    if (clientId.length === 0 || clientId.length > 256 || previous.refreshToken.length > 8192)
      throw new Error("provider request refused")
    const response = await send("https://platform.claude.com/v1/oauth/token", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      tls: { rejectUnauthorized: true },
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: previous.refreshToken,
        client_id: clientId,
      }),
    })
    if (response.status === 429) {
      await response.body?.cancel()
      return null
    }
    if (!response.ok || !response.body) throw new Error("provider custody uncertain")
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of response.body) {
      if (!(chunk instanceof Uint8Array)) throw new Error("provider custody uncertain")
      size += chunk.length
      if (size > 16384) throw new Error("provider custody uncertain")
      chunks.push(chunk)
    }
    const value = Schema.decodeUnknownSync(
      Schema.Struct({
        access_token: Schema.NonEmptyString,
        refresh_token: Schema.NonEmptyString,
        expires_in: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86400 })),
        scope: Schema.String,
      }),
    )(JSON.parse(Buffer.concat(chunks).toString("utf8")))
    return {
      accessToken: value.access_token,
      refreshToken: value.refresh_token,
      expiresAt: Date.now() + value.expires_in * 1000,
      scopes: value.scope.split(" "),
    }
  }

/** One owner for an existing native credential. Null means confirmed no rotation; a throw is uncertain. */
export function makeProviderAccessOwner(
  config: ProviderOwnerConfiguration,
  refresh: ProviderRefresh,
): ProviderAccessOwner {
  let pending: Promise<ProviderSnapshot> | undefined
  const snapshot = async (): Promise<ProviderSnapshot> => {
    const parent = await credentialParent(config.canonical, config.ownerUid)
    let lock
    try {
      lock = await open(
        `${parent.path}.access.lock`,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
    } catch (error) {
      if (lock) {
        await lock.close()
        await parent.handle.close()
        throw error
      }
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        await parent.handle.close()
        throw error
      }
      try {
        lock = await open(`${parent.path}.access.lock`, constants.O_RDWR | constants.O_NOFOLLOW)
      } catch (error) {
        await parent.handle.close()
        throw error
      }
    }
    const libc = dlopen("libc.so.6", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    })
    const privateFile = async (path: string) => {
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      try {
        const info = await file.stat()
        if (
          !info.isFile() ||
          info.uid !== config.ownerUid ||
          info.gid !== config.groupGid ||
          info.nlink !== 1 ||
          (info.mode & 0o777) !== 0o600 ||
          info.size > 65536
        )
          throw new Error("provider custody unavailable")
        return { text: await file.readFile("utf8"), info }
      } finally {
        await file.close()
      }
    }
    const persist = async (path: string, text: string) => {
      const temporary = `${path}.${randomUUID()}`
      const file = await open(temporary, "wx", 0o600)
      try {
        await file.chown(config.ownerUid, config.groupGid)
        await file.chmod(0o600)
        await file.writeFile(text)
        await file.sync()
        const info = await file.stat()
        if (
          info.uid !== config.ownerUid ||
          info.gid !== config.groupGid ||
          (info.mode & 0o777) !== 0o600
        )
          throw new Error("provider custody uncertain")
        await rename(temporary, path)
        await parent.handle.sync()
      } finally {
        await file.close()
        await unlink(temporary).catch((error: unknown) => {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
        })
      }
    }
    try {
      const info = await lock.stat()
      if (
        !info.isFile() ||
        info.uid !== config.ownerUid ||
        info.nlink !== 1 ||
        (info.mode & 0o777) !== 0o600 ||
        libc.symbols.flock(lock.fd, 2 | 4) !== 0
      )
        throw new Error("provider owner busy")
      const canonical = await privateFile(parent.path)
      const raw = canonical.text
      const unchanged = async () => {
        const linked = await lstat(`${parent.path}.access.lock`)
        const current = await privateFile(parent.path)
        if (
          linked.ino !== info.ino ||
          linked.dev !== info.dev ||
          current.info.ino !== canonical.info.ino ||
          current.info.dev !== canonical.info.dev ||
          current.text !== raw
        )
          throw new Error("provider custody uncertain")
      }
      const document = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
        JSON.parse(raw),
      )
      if (config.kind === "api-key") {
        const key = Schema.decodeUnknownSync(
          Schema.Struct({
            apiKey: Schema.NonEmptyString.check(Schema.isMaxLength(8192)),
            expiresAt: Schema.Int,
          }),
        )(document)
        await unchanged()
        if (key.expiresAt <= Date.now()) throw new Error("provider access unavailable")
        return { token: key.apiKey, expiresAt: key.expiresAt }
      }
      const tokens =
        config.kind === "codex"
          ? Schema.decodeUnknownSync(
              Schema.Struct({ auth_mode: Schema.Literal("chatgpt"), tokens: CodexTokens }),
            )(document).tokens
          : undefined
      const oauth = Schema.decodeUnknownSync(OAuth)(
        tokens
          ? {
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token,
              idToken: tokens.id_token,
              accountId: tokens.account_id,
              expiresAt: codexExpiry(tokens.access_token),
              scopes: ["user:inference"],
            }
          : document.claudeAiOauth,
      )
      const snapshot = (access: OAuth) => ({
        token: tokens
          ? JSON.stringify({ accessToken: access.accessToken, accountId: access.accountId })
          : access.accessToken,
        expiresAt: access.expiresAt,
      })
      if (!oauth.scopes.includes("user:inference")) throw new Error("provider scope refused")
      const marker = `${parent.path}.rotation`
      const generation = createHash("sha256").update(raw).digest("hex")
      const rotation = await privateFile(marker).then(
        ({ text }) =>
          Schema.decodeUnknownSync(
            Schema.Struct({
              generation: Schema.String,
              retryAt: Schema.optional(Schema.Int),
            }),
          )(JSON.parse(text)),
        (error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
          throw error
        },
      )
      if (rotation && rotation.retryAt === undefined) throw new Error("provider custody uncertain")
      const retryAt = rotation?.generation === generation ? (rotation.retryAt ?? 0) : 0
      await unchanged()
      const now = Date.now()
      if (oauth.expiresAt > now + 60000 || (now < retryAt && oauth.expiresAt > now))
        return snapshot(oauth)
      if (now < retryAt) throw new Error("provider access unavailable")
      // A crash after the provider accepts rotation must never retry the old refresh token.
      await persist(marker, JSON.stringify({ generation }))
      let rotated: OAuth | null
      try {
        rotated = await refresh(oauth, AbortSignal.timeout(10000))
      } catch {
        throw new Error("provider custody uncertain")
      }
      await unchanged()
      if (rotated === null) {
        // The existing credential-local marker carries confirmed non-rotation
        // too. Persist under flock before publishing old access; another process
        // must observe the same cooldown for this canonical generation.
        await persist(marker, JSON.stringify({ generation, retryAt: Date.now() + 30000 }))
        if (oauth.expiresAt <= Date.now()) throw new Error("provider access unavailable")
        return snapshot(oauth)
      }
      const next = Schema.decodeUnknownSync(OAuth)(rotated)
      if (next.expiresAt <= Date.now() || !next.scopes.includes("user:inference"))
        throw new Error("provider custody uncertain")
      if (tokens && (next.accountId !== tokens.account_id || !next.idToken))
        throw new Error("provider custody uncertain")
      const previousFields = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
        tokens ? document.tokens : document.claudeAiOauth,
      )
      await persist(
        parent.path,
        JSON.stringify(
          tokens
            ? {
                ...document,
                last_refresh: new Date().toISOString(),
                tokens: {
                  ...previousFields,
                  access_token: next.accessToken,
                  refresh_token: next.refreshToken,
                  id_token: next.idToken,
                  account_id: next.accountId,
                },
              }
            : { ...document, claudeAiOauth: { ...previousFields, ...next } },
        ),
      )
      await unlink(marker)
      await parent.handle.sync()
      return snapshot(next)
    } finally {
      await lock.close()
      libc.close()
      await parent.handle.close()
    }
  }
  return {
    snapshot: () => {
      if (pending) return pending
      pending = snapshot().finally(() => {
        pending = undefined
      })
      return pending
    },
  }
}
