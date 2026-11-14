import { Schema } from "effect"

export interface NoscopeConfiguration {
  readonly binary: string
  readonly configHome: string
}
const Envelope = Schema.Array(
  Schema.Struct({
    provider: Schema.String,
    role: Schema.String,
    token: Schema.NonEmptyString,
    token_id: Schema.NonEmptyString,
    expires_at: Schema.String,
  }),
)

/** Noscope owns bounded provider execution; callers bind only its opaque material, never its role as authority. */
export async function mintCapability(
  config: NoscopeConfiguration,
  provider: "run-capability" | "provider-access",
  role: string,
  ttl: number,
  signal: AbortSignal,
) {
  const refused = () => new Error("capability mint refused")
  if (
    !Number.isInteger(ttl) ||
    ttl < 1 ||
    ttl > 3600 ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(role) ||
    !config.binary.startsWith("/") ||
    !config.configHome.startsWith("/")
  )
    throw refused()
  signal.throwIfAborted()
  const child = Bun.spawn(
    [config.binary, "mint", "--provider", provider, "--role", role, "--ttl", String(ttl)],
    {
      env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", XDG_CONFIG_HOME: config.configHome },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    },
  )
  const stop = () => {
    child.kill("SIGKILL")
  }
  signal.addEventListener("abort", stop, { once: true })
  const timeout = setTimeout(stop, 10000)
  try {
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of child.stdout) {
      size += chunk.length
      if (size > 16384) throw refused()
      chunks.push(chunk)
    }
    if ((await child.exited) !== 0) throw refused()
    signal.throwIfAborted()
    const values = Schema.decodeUnknownSync(Envelope)(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    )
    const value = values[0]
    if (
      values.length !== 1 ||
      !value ||
      value.provider !== provider ||
      value.role !== role ||
      value.token.length > 8192
    )
      throw refused()
    const expiresAt = Date.parse(value.expires_at)
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Date.now() ||
      expiresAt > Date.now() + ttl * 1000
    )
      throw refused()
    if (provider === "run-capability" && !/^[A-Za-z0-9_-]{43}$/.test(value.token)) throw refused()
    return { token: value.token, expiresAt }
  } catch {
    throw refused()
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener("abort", stop)
    stop()
    await child.exited
  }
}
