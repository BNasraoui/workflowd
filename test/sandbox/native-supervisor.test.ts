import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"
import { PassThrough, Readable } from "node:stream"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { nativeControlLines, superviseNative } from "../../deploy/sandbox/native-supervisor.mjs"
import { makeNativeDockerBackend } from "../../deploy/sandbox/native-docker.mjs"
import { ownNativeProcess } from "../../deploy/sandbox/native-command.mjs"

test("native closed-record watchdog joins a child that holds stdout open and ignores cancel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-closed-watchdog-"))
  const control = new PassThrough()
  const session = "11111111-1111-4111-8111-111111111111"
  const owned = ownNativeProcess(
    spawn(
      fixtureExecutable("node"),
      [
        "-e",
        `
    const emit = event => console.log(JSON.stringify({...event,session:${JSON.stringify(session)}}));
    emit({event:'started'});
    process.stdin.once('data',()=>emit({event:'closed',outcome:'completed',exitCode:0}));
    setInterval(()=>{},1000);
  `,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    ),
  )
  let stops = 0
  const events: unknown[] = []
  const pending = superviseNative({
    directory,
    request: { nonce: "a".repeat(64), session, deadline: Date.now() + 20000 },
    control,
    backend: {
      async start() {
        return owned
      },
      async stop() {
        expect(await owned.closed).not.toBe(0)
        stops++
      },
    },
    event(event) {
      events.push(event)
      if (event.event === "started") control.write('{"operation":"finish"}\n')
    },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const outcome = await Promise.race([
      pending,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("join timed out"), 6500)
      }),
    ])
    expect(outcome).toBe("operator_required")
    expect(stops).toBe(1)
    expect(events.at(-1)).toMatchObject({
      event: "closed",
      outcome: "operator_required",
      stopped: true,
    })
    expect(() => process.kill(owned.child.pid!, 0)).toThrow()
  } finally {
    clearTimeout(timer)
    owned.child.kill("SIGKILL")
    await owned.closed
    await pending
    control.destroy()
    await rm(directory, { recursive: true, force: true })
  }
}, 10000)

test("recovery stop fences a saved resume before its pending engine launch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-pending-resume-"))
  const control = new PassThrough()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const nonce = "a".repeat(64)
  const request = {
    nonce: "b".repeat(64),
    container: nonce,
    predecessor: nonce,
    resume: true,
    session: "11111111-1111-4111-8111-111111111111",
    model: "fixture",
    effort: "high",
    prompt: "new prompt",
    deadline: Date.now() + 10000,
  }
  await writeFile(
    join(directory, "invocation.json"),
    JSON.stringify({
      ...request,
      nonce,
      state: "paused",
      outcome: "paused",
    }),
  )
  const calls: string[] = []
  let running = false
  let owned: ReturnType<typeof ownNativeProcess> | undefined
  const backend = makeNativeDockerBackend(
    { directory, nonce, image: "ghcr.io/bnasraoui/workflowd-agent-base@sha256:" + "c".repeat(64) },
    {
      async command(args) {
        calls.push(args[0]!)
        if (args[0] === "start") running = true
        if (args[0] === "kill") running = false
        return args[0] === "inspect"
          ? JSON.stringify([
              {
                Id: "d".repeat(64),
                Config: { Labels: { "io.workflowd.native": nonce } },
                State: { Running: running },
              },
            ])
          : ""
      },
      spawn() {
        throw new Error("No export in launch-fence fixture")
      },
      spawnCustodian() {
        owned = ownNativeProcess(
          spawn(
            fixtureExecutable("node"),
            [
              "-e",
              `
        const emit = event => console.log(JSON.stringify({...event,session:${JSON.stringify(request.session)}}));
        process.stdin.once('data',()=>{
          emit({event:'started'});
          process.stdin.once('data',()=>{emit({event:'closed',outcome:'completed',exitCode:0});process.exit(0)});
        });
      `,
            ],
            { stdio: ["pipe", "pipe", "pipe"] },
          ),
        )
        return owned.child
      },
    },
  )
  const pending = superviseNative({
    directory,
    request,
    control,
    backend: {
      async start(value, signal) {
        entered.resolve()
        await release.promise
        return backend.start(value, signal)
      },
      stop: () => backend.stop(),
    },
    event(event) {
      if (event.event === "started") control.write('{"operation":"finish"}\n')
    },
  })
  try {
    await entered.promise
    expect(JSON.parse(await readFile(join(directory, "invocation.json"), "utf8"))).toMatchObject({
      nonce: request.nonce,
      state: "launching",
    })
    await backend.stop({ cancelPending: true })
    expect(running).toBe(false)
    release.resolve()
    expect(await pending).toBe("operator_required")
    expect(calls).not.toContain("start")
    expect(owned).toBeUndefined()
    await expect(backend.start(request)).rejects.toThrow()
  } finally {
    release.resolve()
    await pending
    owned?.child.kill("SIGKILL")
    await owned?.closed
    control.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})

test("host resumes only a verified paused invocation with new nonce and the same native selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-host-resume-"))
  const first = {
    nonce: "a".repeat(64),
    container: "a".repeat(64),
    predecessor: null as string | null,
    resume: false,
    session: "11111111-1111-4111-8111-111111111111",
    model: "fixture",
    effort: "high",
    deadline: Date.now() + 10000,
  }
  let starts = 0,
    stops = 0
  const backend = {
    async start() {
      starts++
      return ownNativeProcess(
        spawn(
          fixtureExecutable("node"),
          [
            "-e",
            `
        const session=${JSON.stringify(first.session)};
        const emit=e=>console.log(JSON.stringify({...e,session}));
        emit({event:'started'});
        process.stdin.once('data',data=>{const operation=JSON.parse(data).operation;emit({event:'closed',outcome:operation==='pause'?'paused':'completed',exitCode:0});process.exit(0)});
      `,
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        ),
      )
    },
    async stop() {
      stops++
    },
  }
  const invoke = async (request: typeof first, operation: string) => {
    const control = new PassThrough()
    try {
      return await superviseNative({
        directory,
        request,
        backend,
        control,
        event(e) {
          if (e.event === "started") control.write(JSON.stringify({ operation }) + "\n")
        },
      })
    } finally {
      control.destroy()
    }
  }
  try {
    expect(await invoke(first, "pause")).toBe("paused")
    const next = { ...first, nonce: "b".repeat(64), predecessor: first.nonce, resume: true }
    for (const altered of [
      { ...next, session: "22222222-2222-4222-8222-222222222222" },
      { ...next, model: "other" },
      { ...next, effort: "low" },
      { ...next, predecessor: "c".repeat(64) },
    ])
      await expect(invoke(altered, "finish")).rejects.toThrow()
    expect(starts).toBe(1)
    expect(await invoke(next, "finish")).toBe("completed")
    expect(starts).toBe(2)
    expect(stops).toBe(2)
    await expect(invoke(next, "finish")).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

for (const fault of [
  "none",
  "missing executable",
  "not executable",
  "early stdin close",
] as const) {
  test(`Docker exec handoff retains supervisor cleanup after ${fault} (real Node child)`, async () => {
    const root = await mkdtemp(join(tmpdir(), "native-spawn-fault-"))
    await mkdir(join(root, "native"))
    await writeFile(join(root, "native/source.tar"), "synthetic archive")
    await writeFile(join(root, "gateway.sock"), "synthetic mount source")
    await writeFile(join(root, "not-executable"), "unexecutable", { mode: 0o600 })
    await writeFile(
      join(root, "supervisor.mjs"),
      `
      import {spawn} from 'node:child_process';
      import {writeFileSync} from 'node:fs';
      import {PassThrough} from 'node:stream';
      import {makeNativeDockerBackend} from ${JSON.stringify(resolve("deploy/sandbox/native-docker.mjs"))};
      import {superviseNative} from ${JSON.stringify(resolve("deploy/sandbox/native-supervisor.mjs"))};
      const nonce='a'.repeat(64), session='11111111-1111-4111-8111-111111111111';
      let running=false, stops=0;
      const control=new PassThrough();
      const engine={
        async command(args) {
          if(args[0]==='start') running=true;
          if(args[0]==='kill') {running=false; stops++}
          return args[0]==='inspect' ? JSON.stringify([{Id:'d'.repeat(64), Config:{Labels:{'io.workflowd.native':nonce}},State:{Running:running}}]) : '';
        },
        spawnCustodian() {
          const fault=${JSON.stringify(fault)};
          const binary=fault==='missing executable' ? ${JSON.stringify(join(root, "missing"))} :
            fault==='not executable' ? ${JSON.stringify(join(root, "not-executable"))} :
            fault==='early stdin close' ? '/bin/true' : process.execPath;
          return spawn(binary, fault==='none' ? ['-e',\`
            const emit=e=>console.log(JSON.stringify({...e,session:'\${session}'}));
            process.stdin.once('data',()=>{
              emit({event:'started'});
              process.stdin.once('data',()=>{emit({event:'closed',outcome:'completed',exitCode:0});process.exit(0)});
            });
          \`] : [], {stdio:['pipe','pipe','pipe']});
        }
      };
      const backend=makeNativeDockerBackend({directory:${JSON.stringify(join(root, "native"))},nonce,image:'ghcr.io/bnasraoui/workflowd-agent-base@sha256:'+'b'.repeat(64)},engine);
      const outcome=await superviseNative({directory:${JSON.stringify(join(root, "native"))},
        request:{nonce,session,model:'fixture',effort:'high',deadline:Date.now()+4000,prompt:'x'.repeat(${fault === "early stdin close" ? 900000 : 10})}, backend,control,
        event(e) {if(e.event==='started')control.write('{"operation":"finish"}\\n')}
      });
      writeFileSync(${JSON.stringify(join(root, "receipt.json"))},JSON.stringify({outcome,running,stops}));
    `,
    )
    const child = spawn(fixtureExecutable("node"), [join(root, "supervisor.mjs")], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    const closed = new Promise((resolve) => child.once("close", resolve))
    const timer = setTimeout(() => child.kill("SIGKILL"), 7000)
    try {
      const [code, stderr] = await Promise.all([
        closed,
        new Response(Readable.toWeb(child.stderr)).text(),
      ])
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
      expect(JSON.parse(await readFile(join(root, "receipt.json"), "utf8"))).toEqual({
        outcome: fault === "none" ? "completed" : "operator_required",
        running: false,
        stops: 1,
      })
    } finally {
      clearTimeout(timer)
      child.kill("SIGKILL")
      await closed
      await rm(root, { recursive: true, force: true })
    }
  }, 10000)
}

test("native control retains split UTF-8 launch and complete finish records", async () => {
  const input = new PassThrough()
  const pending = Array.fromAsync(nativeControlLines(input))
  const bytes = Buffer.from('{"prompt":"雪"}\n{"operation":"finish"}\n')
  for (const byte of bytes) input.write(Buffer.from([byte]))
  input.end()
  expect(await pending).toEqual(['{"prompt":"雪"}', '{"operation":"finish"}'])
})

test("native control teardown joins a pending read without waiting for the SSH writer", async () => {
  const input = new PassThrough()
  const lines = nativeControlLines(input)
  input.write("{}\n")
  expect((await lines.next()).value).toBe("{}")
  const entered = Promise.withResolvers<void>()
  const control = Readable.from(
    (async function* () {
      entered.resolve()
      for await (const line of lines) yield line + "\n"
    })(),
  )
  control.resume()
  await entered.promise
  control.destroy()
  input.destroy()
  expect(await lines.return(undefined)).toMatchObject({ done: true })
})

for (const phase of ["launch", "control"] as const) {
  test(`native ${phase} input is bounded before a newline arrives`, async () => {
    const input = new PassThrough()
    const lines = nativeControlLines(input)
    if (phase === "control") {
      input.write("{}\n")
      expect((await lines.next()).value).toBe("{}")
    }
    const pending = lines.next().then(
      () => false,
      () => true,
    )
    input.write(Buffer.alloc((phase === "launch" ? 1048576 : 4096) + 1, 120))
    try {
      expect(await Promise.race([pending, Bun.sleep(100).then(() => false)])).toBe(true)
    } finally {
      input.end("\n")
      await pending
    }
  })
}

test("native control refuses a partial final record", async () => {
  const input = new PassThrough()
  const pending = Array.fromAsync(nativeControlLines(input))
  input.end('{}\n{"operation":"finish"}')
  await expect(pending).rejects.toThrow()
})

for (const input of [Buffer.from("{}\n{}\n{}\n{}\n"), Buffer.from([0xff, 10])]) {
  test("native control refuses extra records and malformed UTF-8", async () => {
    const stream = new PassThrough()
    const pending = Array.fromAsync(nativeControlLines(stream))
    stream.end(input)
    await expect(pending).rejects.toThrow()
  })
}

// This process-port fixture exercises host supervision, not Docker/UID/network isolation.
for (const fault of [
  "none",
  "lost launch acknowledgement",
  "stop unconfirmed",
  "unrequested completion",
  "cancel after started",
  "PTY overflow at closure",
  "trailing native event",
] as const) {
  test(`native supervisor process-port custody: ${fault}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "native-supervisor-"))
    const session = "11111111-1111-4111-8111-111111111111"
    const request = {
      nonce: "a".repeat(64),
      session,
      model: "fixture-model",
      deadline: Date.now() + 5000,
    }
    const control = new PassThrough()
    const events: unknown[] = []
    let stops = 0
    let starts = 0
    let child: ReturnType<typeof spawn> | undefined
    const backend = {
      async start() {
        starts++
        child = spawn(
          fixtureExecutable("node"),
          [
            "-e",
            `
          const emit = event => process.stdout.write(JSON.stringify({...event,session:${JSON.stringify(session)}})+'\\n');
          process.stderr.write('::error::synthetic-private-canary\\n');
          emit({event:'started'});
          if (${JSON.stringify(fault)} === 'cancel after started') process.stdin.once('data',()=>{emit({event:'closed',outcome:'cancelled',exitCode:0});process.exit(0)});
          else {
            const finish = () => {
              emit({event:'closed',outcome:'completed',exitCode:0});
              if (${JSON.stringify(fault)} === 'trailing native event') {
                process.stdout.on('error', () => process.exit(0));
                setTimeout(() => process.stdout.write(JSON.stringify({event:'started',session:${JSON.stringify(session)}})+'\\n', () => process.exit(0)), 20);
              }
              else if (${JSON.stringify(fault)} === 'PTY overflow at closure') process.stderr.write('x'.repeat(1048576), () => process.exit(0));
              else process.exit(0);
            };
            if (${JSON.stringify(fault)} === 'unrequested completion') finish();
            else process.stdin.once('data', finish);
          }
        `,
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        )
        const owned = ownNativeProcess(child)
        if (fault === "lost launch acknowledgement") throw new Error("launch uncertain")
        return owned
      },
      async stop() {
        stops++
        child?.kill("SIGKILL")
        if (child && child.exitCode === null && child.signalCode === null)
          await new Promise<void>((resolve) => child!.once("close", () => resolve()))
        if (fault === "stop unconfirmed") throw new Error("engine inspection failed")
      },
    }
    try {
      const outcome = await superviseNative({
        directory: root,
        request,
        backend,
        control,
        event(event) {
          events.push(event)
          if (event.event === "started" && fault === "cancel after started")
            control.write('{"operation":"cancel"}\n')
          if (
            event.event === "started" &&
            fault !== "unrequested completion" &&
            fault !== "cancel after started"
          )
            control.write('{"operation":"finish"}\n')
        },
      })
      expect(starts).toBe(1)
      expect(stops).toBe(1)
      expect(outcome).toBe(
        fault === "none"
          ? "completed"
          : fault === "cancel after started"
            ? "cancelled"
            : "operator_required",
      )
      expect(JSON.stringify(events)).not.toContain("synthetic-private-canary")
      const saved = JSON.parse(await readFile(join(root, "invocation.json"), "utf8"))
      expect(saved.nonce).toBe(request.nonce)
      expect(saved.state).toBe(fault === "stop unconfirmed" ? "uncertain" : "stopped")
      if (fault === "none") {
        expect(events).toContainEqual({
          event: "started",
          nonce: request.nonce,
          session,
        })
        expect(events.at(-1)).toEqual({
          event: "closed",
          nonce: request.nonce,
          session,
          outcome: "completed",
          stopped: true,
        })
        expect(await readFile(join(root, `pty-${request.nonce}.log`), "utf8")).toContain(
          "synthetic-private-canary",
        )
      }
      await expect(
        superviseNative({ directory: root, request, backend, control, event() {} }),
      ).rejects.toThrow()
      expect(starts).toBe(1)
    } finally {
      control.destroy()
      child?.kill("SIGKILL")
      await rm(root, { recursive: true, force: true })
    }
  })
}

for (const ending of ["cancel", "control loss", "deadline"] as const) {
  test(`native supervision observes ${ending} during backend startup and joins before stop`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-start-cancel-"))
    const control = new PassThrough()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    let startSettled = false
    let stops = 0
    let child: ReturnType<typeof spawn> | undefined
    const events: unknown[] = []
    const pending = superviseNative({
      directory,
      request: {
        nonce: "a".repeat(64),
        session: "11111111-1111-4111-8111-111111111111",
        deadline: Date.now() + (ending === "deadline" ? 250 : 5000),
      },
      control,
      backend: {
        async start(_request, signal?: AbortSignal) {
          signal?.addEventListener("abort", () => aborted.resolve(), { once: true })
          entered.resolve()
          await release.promise
          startSettled = true
          if (signal?.aborted) throw new Error("Startup cancelled")
          child = spawn(fixtureExecutable("node"), ["-e", "setInterval(() => {}, 1000)"], {
            stdio: ["pipe", "pipe", "pipe"],
          })
          return ownNativeProcess(child)
        },
        async stop() {
          expect(startSettled).toBe(true)
          stops++
        },
      },
      event: (event) => events.push(event),
    })
    try {
      await entered.promise
      if (ending === "cancel") control.write('{"operation":"cancel"}\n')
      if (ending === "control loss") control.end()
      const observed = await Promise.race([
        aborted.promise.then(() => true),
        Bun.sleep(500).then(() => false),
      ])
      expect(observed).toBe(true)
      expect(stops).toBe(0)
      release.resolve()
      expect(await pending).toBe(ending === "cancel" ? "cancelled" : "operator_required")
      expect(stops).toBe(1)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ event: "closed", stopped: true })
    } finally {
      release.resolve()
      control.destroy()
      child?.kill("SIGKILL")
      await pending
      await rm(directory, { recursive: true, force: true })
    }
  }, 15000)
}

test("Docker client custody refuses a foreign container and requires stopped-state readback (no engine proof)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-stop-"))
  const calls: string[][] = []
  const nonce = "b".repeat(64)
  let foreign = false
  let running = true
  const backend = makeNativeDockerBackend(
    { directory, image: "ghcr.io/bnasraoui/workflowd-agent-base@sha256:" + "c".repeat(64), nonce },
    {
      async command(args) {
        calls.push(args)
        if (args[0] === "inspect")
          return JSON.stringify([
            {
              Id: "d".repeat(64),
              Config: { Labels: { "io.workflowd.native": foreign ? "foreign" : nonce } },
              State: { Running: running },
            },
          ])
        if (args[0] === "kill") running = false
        return ""
      },
      spawn() {
        throw new Error("No engine execution in this fixture")
      },
      spawnCustodian() {
        throw new Error("No custodian in stop-only fixture")
      },
    },
  )
  await backend.stop()
  expect(calls.map((call) => call[0])).toEqual(["inspect", "kill", "wait", "inspect"])
  expect(calls.every((call) => call.includes("workflowd-native-" + nonce))).toBe(true)
  calls.length = 0
  foreign = true
  await expect(backend.stop()).rejects.toThrow()
  expect(calls.map((call) => call[0])).toEqual(["inspect"])
  await rm(directory, { recursive: true, force: true })
})

for (const fault of ["none", "abort", "lost start acknowledgement"] as const) {
  test(`Docker startup joins the current engine call before permitting stop: ${fault} (client port only)`, async () => {
    const root = await mkdtemp(join(tmpdir(), "native-start-port-"))
    const directory = join(root, "native")
    await mkdir(directory)
    await writeFile(join(directory, "source.tar"), "synthetic archive")
    await writeFile(join(root, "gateway.sock"), "synthetic mount source")
    const nonce = "a".repeat(64)
    const cancellation = new AbortController()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const calls: string[] = []
    let running = false
    const backend = makeNativeDockerBackend(
      {
        directory,
        nonce,
        image: "ghcr.io/bnasraoui/workflowd-agent-base@sha256:" + "c".repeat(64),
      },
      {
        async command(args) {
          calls.push(args[0]!)
          if (args[0] === "create") {
            entered.resolve()
            await release.promise
          }
          if (args[0] === "start") {
            if (fault === "lost start acknowledgement") throw new Error("Engine reply lost")
            running = true
          }
          if (args[0] === "kill") running = false
          return args[0] === "inspect"
            ? JSON.stringify([
                {
                  Id: "d".repeat(64),
                  Config: { Labels: { "io.workflowd.native": nonce } },
                  State: { Running: running },
                },
              ])
            : ""
        },
        spawn(args) {
          calls.push(args[0]!)
          return spawn(
            fixtureExecutable("node"),
            ["-e", "process.stdin.once('data', () => process.exit(0))"],
            { stdio: ["pipe", "pipe", "pipe"] },
          )
        },
        spawnCustodian() {
          return this.spawn(["exec"])
        },
      },
    )
    const starting = backend.start(
      {
        nonce,
        session: "11111111-1111-4111-8111-111111111111",
        model: "fixture-model",
        effort: "high",
        prompt: "fixture",
        deadline: Date.now() + 5000,
      },
      cancellation.signal,
    )
    try {
      await entered.promise
      if (fault === "abort") cancellation.abort()
      await expect(backend.stop()).rejects.toThrow()
      release.resolve()
      if (fault === "lost start acknowledgement") {
        await expect(starting).rejects.toThrow()
        // A successful stopped-state read alone cannot exclude a delayed start
        // after the client lost its reply. The operation retains custody.
        await expect(backend.stop()).rejects.toThrow()
        expect(calls).not.toContain("exec")
        return
      } else if (fault === "abort") {
        await expect(starting).rejects.toThrow()
        expect(calls).toEqual(["create"])
      } else {
        const owned = await starting
        expect(await owned.closed).toBe(0)
        expect(calls).toContain("exec")
      }
      await backend.stop({ cancelPending: fault === "none" })
      expect(running).toBe(false)
      if (fault === "none")
        await expect(
          backend.start({
            nonce,
            session: "11111111-1111-4111-8111-111111111111",
            model: "fixture-model",
            effort: "high",
            prompt: "late launch",
            deadline: Date.now() + 5000,
          }),
        ).rejects.toThrow()
    } finally {
      release.resolve()
      await starting.catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  })
}

test("concurrent engine operations retain uncertainty rather than acknowledging a racing stop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-race-"))
  const nonce = "a".repeat(64)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let calls = 0
  const backend = makeNativeDockerBackend(
    { directory, image: "ghcr.io/bnasraoui/workflowd-agent-base@sha256:" + "c".repeat(64), nonce },
    {
      async command() {
        calls++
        entered.resolve()
        await release.promise
        return JSON.stringify([
          {
            Id: "d".repeat(64),
            Config: { Labels: { "io.workflowd.native": nonce } },
            State: { Running: false },
          },
        ])
      },
      spawn() {
        throw new Error("No engine in client boundary fixture")
      },
      spawnCustodian() {
        throw new Error("No custodian in stop-only fixture")
      },
    },
  )
  const first = backend.stop()
  try {
    await entered.promise
    await expect(
      Promise.race([backend.stop(), Bun.sleep(100).then(() => "admitted")]),
    ).rejects.toThrow()
    expect(calls).toBe(1)
  } finally {
    release.resolve()
    await first
    await rm(directory, { recursive: true, force: true })
  }
})

test("Docker export requires exact stopped custody and bounds the private archive (client boundary only)", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-client-"))
  const directory = join(root, "native")
  await mkdir(directory)
  const nonce = "a".repeat(64)
  const calls: string[][] = []
  let running = true
  const backend = makeNativeDockerBackend(
    { directory, image: "ghcr.io/bnasraoui/workflowd-agent-base@sha256:" + "c".repeat(64), nonce },
    {
      async command(args) {
        calls.push(args)
        return JSON.stringify([
          {
            Id: "d".repeat(64),
            Config: { Labels: { "io.workflowd.native": nonce } },
            State: { Running: running },
          },
        ])
      },
      spawn(args) {
        calls.push(args)
        return spawn(
          fixtureExecutable("node"),
          ["-e", "process.stdout.write('synthetic-archive')"],
          { stdio: ["pipe", "pipe", "pipe"] },
        )
      },
      spawnCustodian() {
        throw new Error("No custodian in export-only fixture")
      },
    },
  )
  try {
    await expect(backend.exportWorkspace()).rejects.toThrow()
    expect(calls).toHaveLength(1)
    running = false
    await backend.exportWorkspace()
    expect(await readFile(join(directory, "capture.tar"), "utf8")).toBe("synthetic-archive")
    expect(calls.at(-1)).toEqual(["cp", "workflowd-native-" + nonce + ":/workdir/.", "-"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
