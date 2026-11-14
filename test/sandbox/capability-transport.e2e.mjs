// Run only inside a disposable user/network namespace (command in the P1 ticket).
// No harness/provider invocation, inherited SSH configuration, or real credentials.
import assert from "node:assert/strict"
import { test } from "node:test"
import { spawn, execFileSync } from "node:child_process"
import { mkdir, mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises"
import { once } from "node:events"
import { createServer, constants } from "node:http2"
import { userInfo } from "node:os"
import { resolve } from "node:path"
import { attachController } from "../../deploy/sandbox/capability-relay.mjs"

test(
  "standard HTTP/2 carries concurrent native streams and resets over real SSH",
  { timeout: 20000 },
  async () => {
    // sshd StrictModes needs mapped ownership through the current user's HOME.
    await mkdir(".scratch", { recursive: true, mode: 0o700 })
    const root = await mkdtemp(resolve(".scratch/wfd-h2-ssh-"))
    const clean = { PATH: "/usr/bin:/bin", LANG: "C", HOME: root }
    const run = (file, args) =>
      execFileSync(file, args, { env: clean, stdio: ["ignore", "pipe", "pipe"] })
    let sshd
    let ssh
    let session
    let sshdDiagnostic = ""
    const server = createServer({ settings: { maxConcurrentStreams: 8, initialWindowSize: 65535 } })
    const streams = new Set()
    const errors = []
    let blocked = 0
    let slowBytes = 0
    let cancelled = 0
    let completed = 0
    const rssBefore = process.memoryUsage().rss
    const fdBefore = (await readdir("/proc/self/fd")).length
    try {
      for (const name of ["host", "client"])
        run("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", `${root}/${name}`])
      await writeFile(`${root}/authorized_keys`, await readFile(`${root}/client.pub`), {
        mode: 0o600,
      })
      await writeFile(
        `${root}/known_hosts`,
        `[127.0.0.1]:22222 ${await readFile(`${root}/host.pub`, "utf8")}`,
        { mode: 0o600 },
      )
      await writeFile(
        `${root}/sshd_config`,
        [
          "ListenAddress 127.0.0.1",
          "Port 22222",
          `HostKey ${root}/host`,
          `PidFile ${root}/sshd.pid`,
          `AuthorizedKeysFile ${root}/authorized_keys`,
          "StrictModes yes",
          "UsePAM no",
          "PasswordAuthentication no",
          "KbdInteractiveAuthentication no",
          "AuthenticationMethods publickey",
          "PermitRootLogin prohibit-password",
          "DisableForwarding yes",
          "PermitTTY no",
          "PermitUserRC no",
          "PermitUserEnvironment no",
          `AllowUsers ${userInfo().username}`,
          `ForceCommand ${process.execPath} ${resolve("test/sandbox/fixtures/capability-h2-peer.mjs")}`,
          "LogLevel ERROR",
          "",
        ].join("\n"),
        { mode: 0o600 },
      )
      // sshd -D readiness is observed through its private stderr, never a port scan.
      sshd = spawn(
        "/usr/sbin/sshd",
        ["-D", "-e", "-f", `${root}/sshd_config`, "-o", "LogLevel=VERBOSE"],
        { env: clean, stdio: ["ignore", "ignore", "pipe"] },
      )
      sshd.stderr.on("data", (bytes) => {
        sshdDiagnostic += bytes.toString()
        assert.ok(sshdDiagnostic.length < 16384)
      })
      await new Promise((ok, fail) => {
        sshd.stderr.on("data", (bytes) => {
          if (bytes.toString().includes("Server listening")) ok()
        })
        sshd.once("error", fail)
        sshd.once("exit", (code) => fail(new Error(`Fixture sshd startup exited ${code}`)))
      })
      server.on("session", (value) => {
        session = value
        value.on("error", (error) => errors.push(error))
      })
      server.on("stream", (stream, headers) => {
        streams.add(stream)
        stream.on("error", (error) => errors.push(error))
        stream.on("close", () => {
          streams.delete(stream)
          if (stream.rstCode === constants.NGHTTP2_CANCEL) cancelled++
        })
        const chunks = []
        stream.on("data", (chunk) => chunks.push(chunk))
        stream.on("end", () => {
          assert.equal(headers["anthropic-beta"], "oauth-2025-04-20")
          assert.equal(
            Buffer.concat(chunks).toString(),
            '{"model":"synthetic","messages":[{"role":"user","content":"hello"}],"stream":true}',
          )
          stream.respond({ ":status": 200, "content-type": "text/event-stream" })
          if (headers[":path"] === "/slow") {
            const send = () => {
              while (!stream.destroyed) {
                slowBytes += 16384
                if (!stream.write(Buffer.alloc(16384, 120))) {
                  blocked++
                  stream.once("drain", send)
                  return
                }
              }
            }
            send()
          } else if (headers[":path"] === "/cancel") {
            stream.write("event: message_start\ndata: {}\n\n")
          } else if (headers[":path"] === "/receipt") {
            stream.end("ok")
          } else {
            const index = headers[":path"].split("/").at(-1)
            completed++
            stream.write(`event: message_start\ndata: {"id":${index}}\n\n`)
            setImmediate(() => stream.end("event: message_stop\ndata: {}\n\n"))
          }
        })
      })
      ssh = spawn(
        "/usr/bin/ssh",
        [
          "-F",
          "/dev/null",
          "-T",
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          "ForwardAgent=no",
          "-o",
          "ClearAllForwardings=yes",
          "-o",
          "IdentitiesOnly=yes",
          "-o",
          "GlobalKnownHostsFile=/dev/null",
          "-o",
          `UserKnownHostsFile=${root}/known_hosts`,
          "-o",
          "ConnectTimeout=5",
          "-i",
          `${root}/client`,
          "-p",
          "22222",
          `${userInfo().username}@127.0.0.1`,
          "capability-fixture",
        ],
        { env: clean, stdio: ["pipe", "pipe", "pipe"] },
      )
      let diagnostic = ""
      ssh.stderr.on("data", (chunk) => {
        diagnostic += chunk.toString()
        assert.ok(diagnostic.length < 16384)
      })
      attachController(server, ssh)
      const [code] = await once(ssh, "exit")
      assert.equal(code, 0, diagnostic + sshdDiagnostic)
      assert.deepEqual(errors, [])
      assert.equal(completed, 4)
      assert.equal(cancelled, 2)
      assert.ok(blocked > 0)
      assert.ok(slowBytes <= 1024 * 1024, `slow producer queued ${slowBytes}`)
      assert.ok(process.memoryUsage().rss - rssBefore < 64 * 1024 * 1024)
      assert.equal(streams.size, 0)
      assert.ok((await readdir("/proc/self/fd")).length - fdBefore < 12)
      console.log(
        JSON.stringify({
          completed,
          cancelled,
          blocked,
          slowBytes,
          rssDelta: process.memoryUsage().rss - rssBefore,
          fdDelta: (await readdir("/proc/self/fd")).length - fdBefore,
        }),
      )
    } finally {
      for (const stream of streams) stream.destroy()
      session?.destroy()
      server.close()
      for (const child of [ssh, sshd]) {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL")
          await once(child, "exit")
        }
      }
      await rm(root, { recursive: true, force: true })
    }
  },
)
