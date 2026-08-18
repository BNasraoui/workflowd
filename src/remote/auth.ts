import { readFile } from "node:fs/promises"
import { credsAuthenticator } from "@nats-io/nats-core"
import type { ConnectionOptions } from "@nats-io/nats-core"

/**
 * One NATS client identity. Token auth carries no subject permissions, so it
 * only suits single-tenant smoke tests. Creds auth (a decentralized-JWT user
 * with an NKey seed) lets the broker enforce per-identity subject permissions.
 */
export type RemoteNatsAuth =
  | { readonly mode: "token"; readonly token: string }
  | { readonly mode: "creds"; readonly creds: string }

const SOURCE_NAMES = [
  "WORKFLOWD_NATS_TOKEN",
  "WORKFLOWD_NATS_TOKEN_FILE",
  "WORKFLOWD_NATS_CREDS",
  "WORKFLOWD_NATS_CREDS_FILE",
] as const

const exactlyOneMessage =
  "Set exactly one of WORKFLOWD_NATS_TOKEN, WORKFLOWD_NATS_TOKEN_FILE, " +
  "WORKFLOWD_NATS_CREDS, or WORKFLOWD_NATS_CREDS_FILE"

const readCredentialFile = async (
  name: string,
  path: string,
  read: (path: string) => Promise<string>,
): Promise<string> => {
  if (path.trim() === "") throw new Error(`${name} must name a file`)
  let value: string
  try {
    value = await read(path)
  } catch (cause) {
    throw new Error(`Could not read ${name} at ${path}`, { cause })
  }
  value = value.replace(/\r?\n$/, "")
  if (value === "") throw new Error(`${name} must not be empty`)
  return value
}

const credsMarkers = ["-----BEGIN NATS USER JWT-----", "-----BEGIN USER NKEY SEED-----"] as const

const validatedCreds = (name: string, value: string): string => {
  if (value === "") throw new Error(`${name} must not be empty`)
  if (!credsMarkers.every((marker) => value.includes(marker))) {
    throw new Error(`${name} must contain a NATS user JWT and NKey seed in .creds format`)
  }
  return value
}

/**
 * Resolves the single configured NATS credential source. Errors name the
 * environment variables involved and never include credential material.
 * Empty-string values count as unset so a systemd drop-in can disable a
 * source that an earlier unit file already exported (drop-ins can only
 * override an environment variable, never remove it).
 */
export async function loadRemoteNatsAuth(
  env: Record<string, string | undefined>,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<RemoteNatsAuth> {
  const present = SOURCE_NAMES.filter((name) => env[name] !== undefined && env[name] !== "")
  if (present.length !== 1) throw new Error(exactlyOneMessage)
  const source = present[0]!
  switch (source) {
    case "WORKFLOWD_NATS_TOKEN": {
      return { mode: "token", token: env[source]! }
    }
    case "WORKFLOWD_NATS_TOKEN_FILE":
      return { mode: "token", token: await readCredentialFile(source, env[source]!, read) }
    case "WORKFLOWD_NATS_CREDS":
      return { mode: "creds", creds: validatedCreds(source, env[source]!) }
    case "WORKFLOWD_NATS_CREDS_FILE":
      return {
        mode: "creds",
        creds: validatedCreds(source, await readCredentialFile(source, env[source]!, read)),
      }
  }
}

/** Builds the NATS connect options fragment for the configured identity. */
export const natsAuthOptions = (auth: RemoteNatsAuth): ConnectionOptions =>
  auth.mode === "token"
    ? { token: auth.token }
    : { authenticator: credsAuthenticator(new TextEncoder().encode(auth.creds)) }
