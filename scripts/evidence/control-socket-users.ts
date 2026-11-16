import { strict as assert } from "node:assert"
import { chown, lstat, mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
  fixture,
  gatewaySource,
  startGatewayProcess,
} from "../../test/capability-gateway/gateway-process"

/**
 * The control socket and the listener as deployed: the gateway runs as one user, and workflowd
 * and the front as others, and the three share a group. The gateway runs as agent-fixture and is
 * configured for ben-fixture as its daemon and for a third uid of the group as its front.
 * ben-fixture is accepted through the control directory (0710) and socket (0660); another uid of
 * the group gets `caller`; a uid outside the group cannot connect. On the listener, the front's
 * uid is answered; another uid of the group, the daemon's and the gateway's own, is ended before
 * any route; a uid outside the group cannot connect. The gateway refuses a control directory of
 * another owner, one under a directory of another non-root user, and a socket of another uid at
 * its socket's path. This script runs as root, on a disposable CI host, only to take each uid.
 */
const gatewayUid = 61002
const daemonUid = 61001
const groupGid = 61000
const otherUid = 61003
const outsiderUid = 61004
/** The front's uid on the listener: the uid that is "another uid of the group" for the control socket. */
const frontUid = otherUid

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
  await Bun.$`chmod 755 ${f.root}`
  const owned = async (path: string, uid: number, mode: number) => {
    await mkdir(path)
    await chown(path, uid, groupGid)
    // coreutils' chmod: it sets the sticky bit on each Bun this runs on.
    await Bun.$`chmod ${mode.toString(8)} ${path}`
  }
  const home = join(f.root, "gateway-home")
  await owned(home, gatewayUid, 0o700)
  // The deployment's form: the gateway's directory, with its control directory and socket and
  // the listener's directory and socket.
  const run = join(f.root, "run")
  const listenSocket = join(run, "front", "gateway.sock")
  const start = (controlSocket: string) =>
    startGatewayProcess(
      [...as(gatewayUid, groupGid), process.execPath, "-e", gatewaySource(f)],
      {
        ...f.env,
        HOME: home,
        TMPDIR: home,
        WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify({
          ...f.config,
          storePath: join(home, "gateway.db"),
          controlSocket,
          daemon: { uid: daemonUid, gid: groupGid },
          listen: {
            ...f.config.listen,
            socket: listenSocket,
            front: { uid: frontUid, gid: groupGid },
          },
        }),
      },
      f.front,
    )

  // A reconcile on the control socket from `uid` and `gid`, by Python from `/`: the answer, or
  // the name of the connect error.
  const call = async (socket: string, uid: number, gid: number) => {
    const caller = Bun.spawn(
      [
        ...as(uid, gid),
        "python3",
        "-I",
        "-c",
        `import errno, json, socket, struct, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
try:
    s.connect(sys.argv[1])
except OSError as error:
    sys.stdout.write("error " + errno.errorcode[error.errno])
    sys.exit(0)
body = json.dumps({"verb": "reconcile", "body": {"live": []}}).encode()
s.sendall(struct.pack(">I", len(body)) + body)
answer = b""
while True:
    try:
        chunk = s.recv(65536)
    except ConnectionResetError:
        break
    if not chunk:
        break
    answer += chunk
sys.stdout.write(answer[4:].decode() if len(answer) >= 4 else "closed")`,
        socket,
      ],
      { cwd: "/", env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "inherit" },
    )
    const [output, code] = await Promise.all([new Response(caller.stdout).text(), caller.exited])
    assert.equal(code, 0, `the caller as uid ${uid} failed`)
    return output
  }
  const answer = async (socket: string, uid: number, gid: number) => {
    const output = await call(socket, uid, gid)
    try {
      return JSON.parse(output) as unknown
    } catch {
      return output
    }
  }

  await owned(run, gatewayUid, 0o755)
  const socket = join(run, "control", "gateway.sock")
  const gateway = await start(socket)
  gateways.push(gateway)
  assert.deepEqual(await answer(socket, daemonUid, groupGid), { ok: true, value: null })
  assert.deepEqual(await answer(socket, otherUid, groupGid), {
    ok: false,
    error: "caller",
  })
  assert.equal(await call(socket, outsiderUid, outsiderUid), "error EACCES")
  assert.deepEqual(await answer(socket, gatewayUid, groupGid), {
    ok: false,
    error: "caller",
  })
  console.log(
    "control socket: the daemon's uid is accepted, another uid of its group gets caller, and a uid outside the group cannot connect",
  )

  // A request for a challenge on the listener from `uid` and `gid`, with the front's headers, by
  // Python from `/`: the status line of the answer, `ended` when the connection ends with no
  // answer, or the name of the connect error.
  const listenerCall = async (uid: number, gid: number) => {
    const caller = Bun.spawn(
      [
        ...as(uid, gid),
        "python3",
        "-I",
        "-c",
        `import errno, socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
try:
    s.connect(sys.argv[1])
except OSError as error:
    sys.stdout.write("error " + errno.errorcode[error.errno])
    sys.exit(0)
try:
    s.sendall(sys.argv[2].encode())
except OSError:
    pass
answer = b""
while True:
    try:
        chunk = s.recv(65536)
    except ConnectionResetError:
        break
    if not chunk:
        break
    answer += chunk
sys.stdout.write(answer.split(b"\\r\\n")[0].decode() if answer else "ended")`,
        listenSocket,
        `GET /capabilities/v1/challenge?lease=lease HTTP/1.1\r\nhost: localhost\r\nx-forwarded-for: 100.64.0.7\r\nx-forwarded-proto: https\r\nx-forwarded-host: ${f.config.listen.service}\r\nconnection: close\r\n\r\n`,
      ],
      { cwd: "/", env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "inherit" },
    )
    const [output, code] = await Promise.all([new Response(caller.stdout).text(), caller.exited])
    assert.equal(code, 0, `the listener caller as uid ${uid} failed`)
    return output
  }
  // The run is not granted here, so the route answers 503: an answer shows that it ran.
  assert.match(await listenerCall(frontUid, groupGid), /^HTTP\/1\.1 503 /)
  assert.equal(await listenerCall(daemonUid, groupGid), "ended")
  assert.equal(await listenerCall(gatewayUid, groupGid), "ended")
  assert.equal(await listenerCall(outsiderUid, outsiderUid), "error EACCES")
  console.log(
    "listener: the front's uid is answered, another uid of its group is ended before any route, and a uid outside the group cannot connect",
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
  // A socket of another uid at the socket's path, in a control directory that passes: refused,
  // and it stays.
  const taken = join(f.root, "taken")
  await owned(taken, gatewayUid, 0o755)
  await owned(join(taken, "control"), gatewayUid, 0o710)
  const takenSocket = join(taken, "control", "gateway.sock")
  await Bun.$`python3 -c ${"import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])"} ${takenSocket}`
  await chown(takenSocket, daemonUid, groupGid)
  await assert.rejects(start(takenSocket), /is a socket of another user/)
  assert.equal((await lstat(takenSocket)).uid, daemonUid)
  console.log("control socket: a socket of another uid at its path is refused, and stays")
} finally {
  for (const gateway of gateways) await gateway.stop()
  await f.close()
}
