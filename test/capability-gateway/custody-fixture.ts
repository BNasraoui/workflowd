import { expect } from "bun:test"
import { readFileSync } from "node:fs"
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
  sentRefresh,
  sse,
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
        f.front,
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
  const at = client(gateway)
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

/** Waits until `ready` holds, for at most 10 seconds. */
export async function until(ready: () => boolean) {
  const end = Date.now() + 10000
  while (!ready()) {
    if (Date.now() > end) throw new Error("the condition did not come")
    await Bun.sleep(20)
  }
}

/** The call works with the fixture's next access value; the OAuth server got one more request. */
export async function works(gateway: Gateway, token: string, oauth: OAuthFixture, old: string) {
  const before = oauth.requests().length
  const call = await client(gateway).call(token)
  expect(call.status).toBe(200)
  expect(await call.text()).toBe(sse)
  expect(oauth.requests()).toHaveLength(before + 1)
  expect(sentRefresh(oauth.requests().at(-1))).toBe(old)
}

/** The text of a file of /proc, or undefined once the process is gone. */
const procText = (path: string) => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

/** Each process below `pid`, depth first, with its command line. */
export function descendants(pid: number): ReadonlyArray<{ pid: number; command: string }> {
  const children = (procText(`/proc/${pid}/task/${pid}/children`) ?? "")
    .split(" ")
    .filter((part) => part !== "")
    .map(Number)
  return children.flatMap((child) => [
    { pid: child, command: (procText(`/proc/${child}/cmdline`) ?? "").replaceAll("\0", " ") },
    ...descendants(child),
  ])
}

/** Whether the process `pid` has ended: it is gone, or a zombie that no parent has reaped yet. */
export const ended = (pid: number) => {
  const stat = procText(`/proc/${pid}/stat`)
  return stat === undefined || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")
}
