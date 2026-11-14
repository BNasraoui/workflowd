import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { copyFile, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises"
import { PassThrough } from "node:stream"
import { setTimeout as delay } from "node:timers/promises"
import { superviseNative } from "/source/deploy/sandbox/native-supervisor.mjs"
import { makeNativeDockerBackend } from "/source/deploy/sandbox/native-docker.mjs"
import { nativeCommand, ownNativeProcess } from "/source/deploy/sandbox/native-command.mjs"

/** Actual production runner and private-engine containers. Only the pre-engine
 * file-open barrier is fixture instrumentation; stop/start results are real. */
export async function proveLaunchFence({ root, image, engine, request, sessions, nextResponse }) {
  const receipts = []
  for (const order of ["stop-before-launch", "launch-before-stop"]) {
    const home = `${root}/${order}`
    const directory = `${home}/native`
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await copyFile(`${root}/native/source.tar`, `${directory}/source.tar`)
    await symlink(`${root}/gateway.sock`, `${home}/gateway.sock`)
    const first = {
      ...request,
      nonce: randomBytes(32).toString("hex"),
      container: undefined,
      predecessor: null,
      resume: false,
      session: randomUUID(),
      prompt: "Wait for the fixture controller.",
      deadline: Date.now() + 90000,
    }
    sessions.add(first.session)
    const backend = makeNativeDockerBackend({ directory, image, nonce: first.nonce }, engine)
    const control = new PassThrough()
    const response = nextResponse()
    const pauseEvents = []
    const pausing = superviseNative({
      directory,
      request: first,
      backend: {
        start: (...args) => backend.start(...args),
        async stop() {
          try {
            await backend.stop()
          } catch (error) {
            await writeFile(`${home}/stop-error.txt`, String(error))
            throw error
          }
        },
      },
      control,
      event(value) {
        pauseEvents.push(value)
      },
    })
    let owned, timer
    try {
      await Promise.race([
        response,
        pausing.then(() => {
          throw new Error("Native pause fixture ended before provider response")
        }),
      ])
      // Pacing an explicit pause request is not completion evidence.
      await delay(1000)
      control.write('{"operation":"pause"}\n')
      const pausedOutcome = await pausing
      await writeFile(`${home}/pause-events.json`, JSON.stringify(pauseEvents))
      assert.equal(pausedOutcome, "paused")
      const name = `workflowd-native-${first.nonce}`
      const paused = JSON.parse(await engine.command(["inspect", name]))[0]
      assert.equal(paused.State.Running, false)
      const resume = {
        ...first,
        container: first.nonce,
        nonce: randomBytes(32).toString("hex"),
        predecessor: first.nonce,
        resume: true,
        prompt: "Continue the same fixture session.",
      }
      await writeFile(`${home}/execution-mode`, "actions-native")
      await writeFile(`${home}/agent-image`, image)
      await writeFile(`${home}/native-deadline`, String(resume.deadline))
      await unlink("/run/workflowd-sandbox")
      await symlink(home, "/run/workflowd-sandbox")
      const barrier = `${home}/barrier.mjs`
      await writeFile(
        barrier,
        `
        import fs from 'node:fs';
        import {syncBuiltinESMExports} from 'node:module';
        const open=fs.promises.open;
        fs.promises.open=async(path,...args)=>{
          if(path===${JSON.stringify(`/run/workflowd-sandbox/native/pty-${resume.nonce}.log`)}){
            const released=new Promise(resolve=>process.once('SIGUSR1',resolve));
            fs.writeSync(3,'launching\\n');
            await released;
          }
          return open(path,...args);
        };
        syncBuiltinESMExports();
      `,
        { mode: 0o600 },
      )
      const child = spawn(
        "/bin/node",
        [
          ...(order === "stop-before-launch" ? ["--import", barrier] : []),
          "/source/deploy/sandbox/native-runner.mjs",
          "native-execute",
        ],
        {
          env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
          stdio: ["pipe", "pipe", "pipe", "pipe"],
        },
      )
      owned = ownNativeProcess(child)
      timer = setTimeout(() => child.kill("SIGKILL"), 20000)
      const started = Promise.withResolvers()
      void owned.closed.then(() =>
        started.reject(new Error("Runner exited before started receipt")),
      )
      void started.promise.catch(() => undefined)
      const events = []
      const output = (async () => {
        let buffer = "",
          size = 0
        for await (const bytes of child.stdout) {
          size += bytes.length
          assert.ok(size <= 65536)
          buffer += bytes
          let end
          while ((end = buffer.indexOf("\n")) !== -1) {
            const value = JSON.parse(buffer.slice(0, end))
            buffer = buffer.slice(end + 1)
            events.push(value)
            if (value.event === "started") started.resolve()
          }
        }
        assert.equal(buffer, "")
      })()
      const diagnostic = (async () => {
        let size = 0
        for await (const bytes of child.stderr) {
          size += bytes.length
          assert.ok(size <= 4096)
        }
      })()
      const waiting =
        order === "stop-before-launch"
          ? new Promise((resolve, reject) => {
              child.stdio[3].once("data", (bytes) => {
                assert.equal(bytes.toString(), "launching\n")
                resolve()
              })
              child.once("close", () => reject(new Error("Runner exited before launch barrier")))
            })
          : started.promise
      child.stdin.write(JSON.stringify(resume) + "\n")
      await waiting
      assert.equal(
        JSON.parse(await readFile(`${directory}/invocation.json`, "utf8")).nonce,
        resume.nonce,
      )
      const stop = JSON.parse(
        await nativeCommand(
          ["/bin/node", "/source/deploy/sandbox/native-runner.mjs", "native-stop"],
          "",
          { directory: home, timeoutMs: 10000 },
        ),
      )
      assert.deepEqual(stop, { nonce: resume.nonce, session: resume.session, stopped: true })
      if (order === "stop-before-launch") child.kill("SIGUSR1")
      assert.equal(await owned.closed, 0)
      await Promise.all([output, diagnostic])
      const stopped = JSON.parse(await engine.command(["inspect", name]))[0]
      assert.equal(stopped.State.Running, false)
      assert.equal(stopped.State.Pid, 0)
      assert.equal(events.at(-1).outcome, "operator_required")
      if (order === "stop-before-launch") {
        assert.equal(stopped.State.StartedAt, paused.State.StartedAt)
        assert.ok(!events.some((value) => value.event === "started"))
      } else assert.ok(events.some((value) => value.event === "started"))
      await assert.rejects(backend.start(resume))
      await backend.remove()
      receipts.push({
        order,
        productionRunner: true,
        priorCleanPause: true,
        stopReceipt: stop,
        pendingLaunchFenced: true,
        runnerJoined: true,
        stoppedPid: 0,
        removed: true,
      })
    } finally {
      clearTimeout(timer)
      owned?.child.kill("SIGKILL")
      await owned?.closed
      control.destroy()
      await pausing
      sessions.delete(first.session)
      await unlink("/run/workflowd-sandbox")
      await symlink(root, "/run/workflowd-sandbox")
    }
  }
  await writeFile(`${root}/launch-fence.json`, JSON.stringify(receipts, null, 2), { mode: 0o600 })
}
