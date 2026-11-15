import { strict as assert } from "node:assert"
import { chmod, chown, mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
  fixture,
  gatewaySource,
  startGatewayProcess,
} from "../../test/capability-gateway/gateway-process"

/**
 * The control socket as deployed: the gateway runs as one user and workflowd as another, and the
 * two share a group. The gateway runs as agent-fixture and is configured for ben-fixture as its
 * daemon, with their shared group. ben-fixture is accepted through the directory (0710) and the
 * socket (0660); another uid of the group gets `caller`; a uid outside the group cannot connect.
 * The gateway refuses a control directory of another owner, and one under a directory of another
 * non-root user. This script runs as root, on a disposable CI host, only to take each uid.
 */
const gatewayUid = 61002
const daemonUid = 61001
const groupGid = 61000
const otherUid = 61003
const outsiderUid = 61004

assert.equal(process.getuid?.(), 0, "run as root, to take each fixture uid")
const as = (uid: number, gid: number) => [
  "setpriv",
  `--reuid=${uid}`,
  `--regid=${gid}`,
  "--clear-groups",
  "--",
]

const f = await fixture()
const gateways: Array<{ stop(): Promise<void> }> = []
try {
  await chmod(f.root, 0o755)
  const owned = async (path: string, uid: number, mode: number) => {
    await mkdir(path)
    await chown(path, uid, groupGid)
    await chmod(path, mode)
  }
  const home = join(f.root, "gateway-home")
  await owned(home, gatewayUid, 0o700)
  const start = (controlSocket: string) =>
    startGatewayProcess([...as(gatewayUid, groupGid), process.execPath, "-e", gatewaySource(f)], {
      ...f.env,
      HOME: home,
      WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify({
        ...f.config,
        storePath: join(home, "gateway.db"),
        controlSocket,
        daemon: { uid: daemonUid, gid: groupGid },
      }),
    })

  // A reconcile on the control socket from `uid` and `gid`: the answer, or the connect error.
  const call = async (socket: string, uid: number, gid: number) => {
    const caller = Bun.spawn(
      [
        ...as(uid, gid),
        process.execPath,
        "-e",
        `const net = require("node:net")
const body = Buffer.from(JSON.stringify({ verb: "reconcile", body: { live: [] } }))
const header = Buffer.alloc(4)
header.writeUInt32BE(body.length)
const connection = net.createConnection(${JSON.stringify(socket)})
let answer = Buffer.alloc(0)
connection.on("connect", () => connection.write(Buffer.concat([header, body])))
connection.on("data", (chunk) => { answer = Buffer.concat([answer, chunk]) })
connection.on("error", (error) => { process.stdout.write("error " + error.code); process.exit(0) })
connection.on("close", () => process.stdout.write(answer.length >= 4 ? answer.subarray(4).toString() : "closed"))`,
      ],
      { env: { PATH: process.env.PATH, HOME: "/tmp" }, stdout: "pipe", stderr: "inherit" },
    )
    const [output, code] = await Promise.all([new Response(caller.stdout).text(), caller.exited])
    assert.equal(code, 0, `the caller as uid ${uid} failed`)
    return output
  }

  // The deployment's form: the gateway's directory, its control directory and socket.
  const run = join(f.root, "run")
  await owned(run, gatewayUid, 0o755)
  const socket = join(run, "control", "gateway.sock")
  const gateway = await start(socket)
  gateways.push(gateway)
  assert.deepEqual(JSON.parse(await call(socket, daemonUid, groupGid)), { ok: true, value: null })
  assert.deepEqual(JSON.parse(await call(socket, otherUid, groupGid)), {
    ok: false,
    error: "caller",
  })
  assert.equal(await call(socket, outsiderUid, outsiderUid), "error EACCES")
  assert.deepEqual(JSON.parse(await call(socket, gatewayUid, groupGid)), {
    ok: false,
    error: "caller",
  })
  console.log(
    "control socket: the daemon's uid is accepted, another uid of its group gets caller, and a uid outside the group cannot connect",
  )

  // A control directory of another owner, under a directory that passes: refused.
  const wrongOwner = join(f.root, "wrong-owner")
  await owned(wrongOwner, gatewayUid, 0o755)
  await owned(join(wrongOwner, "control"), daemonUid, 0o710)
  await assert.rejects(
    start(join(wrongOwner, "control", "gateway.sock")),
    /control socket directory must be the gateway's/,
  )
  // A sticky directory above the control directory, owned by another non-root user: refused.
  const foreign = join(f.root, "foreign")
  await owned(foreign, daemonUid, 0o1777)
  await assert.rejects(
    start(join(foreign, "control", "gateway.sock")),
    /lets another user replace the control socket directory/,
  )
  console.log(
    "control socket: a control directory of another owner, and one under a directory of another user, are refused",
  )
} finally {
  for (const gateway of gateways) await gateway.stop()
  await f.close()
}
