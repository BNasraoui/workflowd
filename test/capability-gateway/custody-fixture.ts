import { expect } from "bun:test"
import { readFile, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import {
  client,
  custodyEnv,
  fixture,
  gatewaySource,
  importLogin,
  oauthFixture,
  proof,
  startGatewayProcess,
  writeCustodyProvider,
  type Fixture,
  type Gateway,
  type OAuthFixture,
} from "./gateway-process"

/**
 * The custody cases' shared parts: a fixture with the gateway's provider-access set to custody of
 * a Claude login in its login directory, a fixture OAuth server, gateway processes on both, and
 * the search for a value in an output.
 */

export const loginDirectory = (f: Fixture) => join(f.root, "login")
export const loginFile = (f: Fixture) => join(loginDirectory(f), "claude.json")
export const mode = async (path: string) =>
  ((await stat(path)).mode & 0o777).toString(8).padStart(4, "0")

/** The forms a value could leak in: plain, base64 and base64url. */
export const forms = (value: string) => [
  value,
  Buffer.from(value).toString("base64"),
  Buffer.from(value).toString("base64url"),
]
export const leaked = (text: string, values: ReadonlyArray<string>) =>
  values.flatMap(forms).filter((form) => text.includes(form))

/** Every byte of both stores, their journals included. */
export async function storeBytes(f: Fixture) {
  const names = (await readdir(f.root)).filter((name) => /\.db(-wal|-shm|-journal)?$/.test(name))
  expect(names).toContain("gateway.db")
  const parts = await Promise.all(names.map((name) => readFile(join(f.root, name))))
  return Buffer.concat(parts).toString("latin1")
}

export async function withCustody(
  body: (
    f: Fixture,
    oauth: OAuthFixture,
    start: () => Promise<Gateway>,
    outputs: string[],
  ) => Promise<void>,
) {
  const f = await fixture()
  const oauth = oauthFixture()
  const gateways: Gateway[] = []
  const outputs: string[] = []
  try {
    await writeCustodyProvider(f.root, loginDirectory(f), oauth.url)
    const start = async () => {
      const gateway = await startGatewayProcess(
        [process.execPath, "-e", gatewaySource(f)],
        custodyEnv(f, loginDirectory(f)),
      )
      gateways.push(gateway)
      await f.reconcile()
      return gateway
    }
    await body(f, oauth, start, outputs)
  } finally {
    for (const gateway of gateways) await gateway.stop()
    await oauth.stop()
    await f.close()
  }
}

/** A session of the fixture run on `gateway`, and its run token. */
export async function runToken(gateway: Gateway, jti: string) {
  const at = client(gateway.port)
  const challenge = await at.audience()
  const opened = await at.session(proof(challenge.audience, jti))
  expect(opened.status).toBe(200)
  return (await at.grant(opened)).token
}

export async function imported(f: Fixture, login: object) {
  const result = await importLogin(custodyEnv(f, loginDirectory(f)), JSON.stringify(login))
  expect(result).toMatchObject({ code: 0, stderr: "" })
  return result
}
