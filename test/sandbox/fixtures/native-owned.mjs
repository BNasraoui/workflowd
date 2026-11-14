import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { once } from "node:events"
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { PassThrough } from "node:stream"
import { setTimeout as delay } from "node:timers/promises"
import { makeNativeDockerBackend } from "/source/deploy/sandbox/native-docker.mjs"
import { superviseNative } from "/source/deploy/sandbox/native-supervisor.mjs"
import { captureNativeResult } from "/source/deploy/sandbox/native-capture.mjs"
import { nativeCommand } from "/source/deploy/sandbox/native-command.mjs"
import { nativeToolResponse, nativeToolResult } from "/source/native-provider.mjs"

const root = "/evidence/native-runtime"
const directory = `${root}/native`
const tooling = "/source/deploy/sandbox"
const applicationProof = process.env.WORKFLOWD_FIXTURE_NATIVE_APP === "1"
const applicationFailure = process.env.WORKFLOWD_FIXTURE_NATIVE_FAULT === "1"
const nativeClient = process.env.WORKFLOWD_FIXTURE_NATIVE_CLIENT ?? "claude"
assert.ok(["claude", "codex", "opencode"].includes(nativeClient))
const adapter = nativeClient !== "claude"
const sourceDirectory = applicationProof ? `${root}/source-fixture` : directory
await mkdir(sourceDirectory, { recursive: true, mode: 0o700 })
const canary = `fixture-private-${randomBytes(16).toString("hex")}\n::error::private-native-output`
const canaries = [
  canary,
  Buffer.from(canary).toString("base64"),
  Buffer.from(canary).toString("hex"),
  encodeURIComponent(canary),
]
await writeFile(`${root}/private-canaries.json`, JSON.stringify(canaries), { mode: 0o600 })
const imageId = (await readFile("/evidence/agent-image-id", "utf8")).trim()
assert.match(imageId, /^sha256:[a-f0-9]{64}$/)
// The exact locally built content is loaded into the private engine; no published
// registry digest is claimed. Only this image-reference translation is substituted.
const image = `ghcr.io/bnasraoui/workflowd-agent-base@${imageId}`
await writeFile(`${root}/agent-image`, image, { mode: 0o600, flag: "wx" })
await writeFile(`${root}/execution-mode`, "actions-native", { mode: 0o600, flag: "wx" })
const environment = { PATH: "/usr/bin:/bin", HOME: "/nonexistent" }
const engine = {
  spawnCustodian(client) {
    return spawn(
      "/usr/bin/python3",
      ["-I", `/source/deploy/sandbox/${client ? "native-client" : "claude-interactive"}.py`],
      {
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
      },
    )
  },
  spawn(args) {
    return spawn(
      "/usr/bin/docker",
      args.map((value) => (value === image ? imageId : value)),
      {
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
      },
    )
  },
  async command(args, input = "") {
    const child = this.spawn(args)
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("close", resolve)
    })
    // Private VFS copy-on-create is slower than the production overlay engine;
    // retain the approved 90s creation bound within the 5min outer fixture bound.
    const timer = setTimeout(() => child.kill("SIGKILL"), args[0] === "create" ? 90000 : 30000)
    const capture = async (stream) => {
      let output = ""
      for await (const chunk of stream) {
        output += chunk
        assert.ok(output.length <= 1048576)
      }
      return output
    }
    child.stdin.on("error", () => {})
    child.stdin.end(input)
    try {
      const [code, out, err] = await Promise.all([
        closed,
        capture(child.stdout),
        capture(child.stderr),
      ])
      assert.equal(code, 0, err)
      return out.trim()
    } finally {
      clearTimeout(timer)
      child.kill("SIGKILL")
      await closed
    }
  },
}
const command = (args, input = "") => nativeCommand(args, input, { directory })
const sourceCommand = (args) => nativeCommand(args, "", { directory: sourceDirectory })
await sourceCommand(["/bin/git", "init", "source"])
await writeFile(`${sourceDirectory}/source/README.md`, "Synthetic native source\n")
await sourceCommand(["/bin/git", "-C", "source", "add", "README.md"])
await sourceCommand([
  "/bin/git",
  "-C",
  "source",
  "-c",
  "user.name=Workflowd Agent",
  "-c",
  "user.email=agent@workflowd.invalid",
  "commit",
  "-m",
  "Source",
])
const sourceSha = await sourceCommand(["/bin/git", "-C", "source", "rev-parse", "HEAD"])
await sourceCommand(["/bin/git", "clone", "--bare", "source", "source.git"])
await sourceCommand([
  "/bin/git",
  "-C",
  "source.git",
  "bundle",
  "create",
  `${sourceDirectory}/source.bundle`,
  "HEAD",
])
let gitDaemon
let gitClosed
if (applicationProof) {
  await writeFile(`${root}/identity.json`, JSON.stringify({ repository: "fixture/repo" }), {
    mode: 0o600,
  })
  gitDaemon = spawn(
    "/bin/git",
    [
      "daemon",
      "--reuseaddr",
      "--verbose",
      "--export-all",
      "--listen=127.0.0.1",
      "--port=19418",
      `--base-path=${root}`,
      root,
    ],
    { env: environment, stdio: ["ignore", "ignore", "pipe"] },
  )
  gitClosed = once(gitDaemon, "close")
  const [ready] = await once(gitDaemon.stderr, "data")
  assert.match(ready.toString(), /Ready to rumble/)
} else {
  await command(["/usr/bin/python3", "-I", `${tooling}/result.py`, "native-source", sourceSha])
  await writeFile(`${root}/source.sha`, sourceSha)
}
let request = {
  nonce: randomBytes(32).toString("hex"),
  session: randomUUID(),
  model: adapter ? "gpt-5.5" : "claude-opus-4-6",
  ...(adapter ? { client: nativeClient, provider: "openai" } : {}),
  effort: "high",
  prompt:
    "Perform the synthetic native tool sequence, submit its corrected result, and finish. Private input: " +
    canaries.join("\n"),
  deadline: Date.now() + 90000,
}
assert.ok(!applicationFailure || applicationProof)
let application = applicationProof
  ? await (
      await import("/source/native-owned-app.mjs")
    ).makeOwnedApplication(root, request, sourceSha)
  : null
if (application) request = application.request
const completion = {
  branch: "chosen/native-runtime",
  title: "Native container result",
  body: "Synthetic native result.",
  commitMessage: "Native container result",
}
const isolation = `import os,pathlib; assert os.getuid()==os.getgid()==1000; assert not any(k.startswith(('ACTIONS_ID_TOKEN','GITHUB_')) for k in os.environ); assert not any(pathlib.Path(p).exists() for p in ['/var/run/docker.sock','/run/owned-engine/docker.sock','/evidence']); s=pathlib.Path('/proc/self/status').read_text(); assert 'CapEff:\\t0000000000000000'.replace('\\t','\t') in s; assert 'NoNewPrivs:\\t1'.replace('\\t','\t') in s; pathlib.Path('/workdir/isolation.txt').write_text('uid=1000 gid=1000 capabilities=0 no_new_privileges=1\\n')`
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"
const actions = [
  [
    "Bash",
    {
      command: `python3 -c ${quote(`import os,json,pathlib,time,http.client
home=pathlib.Path(os.environ['HOME'])
session=${JSON.stringify(request.session)}
path=home/'.claude/projects/forged'/ (session+'.jsonl')
path.parent.mkdir(parents=True,exist_ok=True)
path.write_text(json.dumps({'type':'assistant','message':{'model':${JSON.stringify(request.model)},'usage':{'output_tokens':99999}}})+'\\n')
(home/'native-transcript.json').write_text(json.dumps({'session':session,'path':str(path)}))
(home/'stops.jsonl').write_text(json.dumps({'event':'Stop','session':session})+'\\n')
print(json.dumps({'event':'closed','session':session,'outcome':'completed','exitCode':0}),flush=True)
assert not pathlib.Path('/evidence').exists()
assert not pathlib.Path('/source').exists()
assert not pathlib.Path('/run/workflowd-sandbox/native/invocation.json').exists()
if ${applicationProof ? "True" : "False"}:
 for target in ['/workflows/agent-runs/agent-run-forged/native','/capabilities/v1/publish']:
  connection=http.client.HTTPConnection('127.0.0.1',31741,timeout=5)
  connection.request('POST',target,json.dumps({'operation':'resume','nonce':'a'*64,'prompt':'forge controller continuation'}),{'authorization':'Bearer workflowd-local','content-type':'application/json'})
  response=connection.getresponse()
  assert response.status==403, (target,response.status)
  assert len(response.read(4097))<=4096
  connection.close()
 print('controller resume and publication authority refused',flush=True)
processes=[]
for candidate in pathlib.Path('/proc').iterdir():
 if candidate.name.isdigit():
  try: processes.append((candidate/'cmdline').read_bytes()[:8192].decode(errors='replace'))
  except (OSError,PermissionError): pass
assert len(processes)<=512
print(json.dumps({'agentVisibleProcesses':processes}),flush=True)
time.sleep(1)
print('forged advisory files and PTY protocol')`)}`,
      description: "Attempt advisory lifecycle forgery",
    },
  ],
  ["Write", { file_path: "/workdir/result.txt", content: "Actual native container tool result\n" }],
  ["Read", { file_path: "/workdir/result.txt" }],
  [
    "Bash",
    {
      command: `python3 -c ${quote("import sys;sys.stdout.write(" + JSON.stringify(canaries.join("\n")) + ")")}`,
      description: "Private diagnostic output",
    },
  ],
  [
    "Bash",
    {
      command: `python3 -c ${quote(isolation)}`,
      description: "Verify disposable native isolation",
    },
  ],
  ...[0, 1].map((revision) => [
    "Bash",
    {
      command: `python3 /opt/workflowd/claude-interactive.py submit ${quote(JSON.stringify({ revision, completion: { ...completion, title: revision ? completion.title : "Initial candidate" } }))}`,
      description: "Submit native candidate",
    },
  ]),
]
if (applicationFailure)
  actions.splice(0, actions.length, [
    "Bash",
    {
      command: `python3 -c ${quote("import os,time;open('/workdir/child.pid','w').write(str(os.getpid()));time.sleep(120)")}`,
      description: "Owned SQL-failure sleeping tool",
    },
  ])
const requests = [],
  results = []
const cohortSessions = new Set()
let finalResponse = Promise.withResolvers()
let revision = 0,
  sequence = 0
let candidate
const server = createServer(async (incoming, response) => {
  try {
    let raw = ""
    for await (const chunk of incoming) {
      raw += chunk
      assert.ok(raw.length <= 1048576)
    }
    assert.equal(
      incoming.headers.authorization,
      application ? "Bearer fixture-access" : "Bearer workflowd-local",
    )
    assert.equal(incoming.headers["x-api-key"], undefined)
    const body = JSON.parse(raw)
    if (incoming.url === "/capabilities/v1/result") {
      assert.equal(body.revision, revision)
      candidate = body.completion
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify({ revision: ++revision }))
      return
    }
    if (adapter) {
      if (nativeClient === "codex" && application)
        assert.equal(incoming.headers["chatgpt-account-id"], "fixture-account")
      assert.equal(
        incoming.url,
        (application ? "" : "/capabilities/v1/providers/openai") +
          (nativeClient === "codex" ? "/responses" : "/chat/completions"),
      )
    } else {
      assert.match(incoming.url, /^\/v1\/messages(?:\?beta=true)?$/)
      const session = incoming.headers["x-claude-code-session-id"]
      assert.ok(cohortSessions.size ? cohortSessions.has(session) : session === request.session)
      assert.ok(incoming.headers["anthropic-beta"].includes("oauth-2025-04-20"))
    }
    assert.equal(body.model, request.model)
    requests.push(body)
    const main = Boolean(body.tools?.length)
    if (main && sequence)
      results.push(
        ...(adapter
          ? nativeToolResult(nativeClient, body, sequence)
          : body.messages.at(-1).content.filter((item) => item.type === "tool_result")),
      )
    const action = main ? actions.shift() : undefined
    if (main) sequence++
    const events = [
      {
        type: "message_start",
        message: {
          id: `msg_${sequence}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: action
          ? { type: "tool_use", id: `tool_${sequence}`, name: action[0], input: {} }
          : { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: action
          ? { type: "input_json_delta", partial_json: JSON.stringify(action[1]) }
          : { type: "text_delta", text: "Synthetic native turn complete." },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: action ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ]
    response.setHeader("Content-Type", "text/event-stream")
    response.setHeader("X-Fixture-Private", canaries[1])
    if (adapter) {
      response.setHeader("x-request-id", `req-private-fixture-${sequence}`)
      response.setHeader(
        nativeClient === "codex"
          ? "x-codex-primary-used-percent"
          : "x-ratelimit-remaining-requests",
        "42",
      )
    }
    response.end(
      adapter
        ? nativeToolResponse(nativeClient, body, action, sequence)
        : events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
    )
    if (main && !action) finalResponse.resolve()
  } catch (error) {
    await writeFile(`${root}/upstream-error.txt`, String(error))
    response.statusCode = 500
    response.end()
  }
})
await new Promise((resolve, reject) => {
  server.once("error", reject)
  server.listen(`${root}/${application ? "upstream" : "gateway"}.sock`, resolve)
})
const backend = makeNativeDockerBackend({ directory, image, nonce: request.nonce }, engine)
const control = new PassThrough()
const events = []
try {
  if (process.env.WORKFLOWD_FIXTURE_NATIVE_FENCE === "only") {
    const { proveLaunchFence } = await import("/source/native-owned-fence.mjs")
    await proveLaunchFence({
      root,
      image,
      engine,
      request,
      sessions: cohortSessions,
      nextResponse() {
        sequence = 0
        finalResponse = Promise.withResolvers()
        return finalResponse.promise
      },
    })
  } else if (applicationFailure) {
    let childPid
    await application.fault(async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          childPid = await engine.command([
            "exec",
            `workflowd-native-${request.container}`,
            "/bin/cat",
            "/workdir/child.pid",
          ])
          break
        } catch {
          await delay(100)
        }
      }
      assert.match(childPid ?? "", /^[0-9]+$/)
      assert.equal(
        JSON.parse(await engine.command(["inspect", `workflowd-native-${request.container}`]))[0]
          .State.Running,
        true,
      )
    })
    // The lease caller and failure observer can both request idempotent stop.
    assert.match(await readFile(`${root}/native-stop-requested`, "utf8"), /^(stop\n){1,8}$/)
    const stopped = JSON.parse(
      await engine.command(["inspect", `workflowd-native-${request.container}`]),
    )[0]
    assert.equal(stopped.State.Running, false)
    assert.equal(stopped.State.Pid, 0)
    await backend.remove()
    await writeFile(
      `${root}/receipt.json`,
      JSON.stringify({
        scenario: "sql-fault",
        applicationProof: true,
        sqlRollbackRetained: true,
        remoteStopAttempted: true,
        remoteStopped: true,
        pid: 0,
        removed: true,
        imageId,
      }),
      { mode: 0o600 },
    )
  } else {
    const finishing = (async () => {
      await finalResponse.promise
      if (application) {
        const stored = await application.candidate()
        assert.equal(stored.frozen, 0)
        revision = stored.revision
        candidate = stored.completion
      }
      // Explicit fixture-controller decision after checking its expected tools and
      // candidate. This pacing is not production completion or native attestation.
      assert.equal(sequence, 8)
      assert.equal(revision, 2)
      assert.ok(results.every((result) => !result.is_error))
      await delay(1000)
      control.write('{"operation":"pause"}\n')
    })()
    void finishing.catch(() => control.write('{"operation":"cancel"}\n'))
    assert.equal(
      await (application
        ? application.execute(request, control, (value) => events.push(value))
        : superviseNative({
            directory,
            request,
            backend,
            control,
            event(value) {
              events.push(value)
              assert.ok(
                ["started", "closed"].includes(value.event),
                "Untrusted native claim promoted",
              )
            },
          })),
      "paused",
    )
    await finishing
    if (application) {
      assert.equal(await readFile(`${root}/source.sha`, "utf8"), sourceSha)
      assert.equal(
        await command(["/bin/git", "-C", "source.git", "rev-parse", "FETCH_HEAD"]),
        sourceSha,
      )
      await copyFile(`${sourceDirectory}/source.bundle`, `${directory}/source.bundle`)
      await writeFile(
        `${root}/initialization.json`,
        JSON.stringify({
          productionSshInitialize: true,
          fetchedSourceSha: sourceSha,
          realGitDaemon: true,
          syntheticGitOrigin: true,
          registryAcquisition: "verified-local-archive",
          privateOuterNetwork: true,
        }),
        { mode: 0o600 },
      )
    }
    assert.equal(sequence, 8)
    assert.equal(results.length, 7)
    const paused = JSON.parse(await readFile(`${directory}/invocation.json`, "utf8"))
    if (adapter) request.session = paused.session
    assert.equal(paused.state, "paused")
    await assert.rejects(
      captureNativeResult({
        root,
        directory,
        invocation: paused,
        request: { nonce: request.nonce, session: request.session, completion },
        backend,
        command,
        tooling,
      }),
      /Capture custody/,
    )
    const initialPrompt = request.prompt
    request = application
      ? await application.resume("Read the existing result in this same native session.")
      : {
          ...request,
          container: request.nonce,
          predecessor: request.nonce,
          nonce: randomBytes(32).toString("hex"),
          resume: true,
          prompt: "Read the existing result in this same native session.",
        }
    actions.push(["Read", { file_path: "/workdir/result.txt" }])
    if (application)
      actions.push([
        "Bash",
        {
          command: `python3 -c ${quote(`import http.client,json,subprocess,pathlib
for body,status in [({'operation':'finalize','revision':0},400),({'operation':'finalize','revision':1},409),({'operation':'finalize','revision':2,'command':'arbitrary'},400)]:
 connection=http.client.HTTPConnection('127.0.0.1',31741,timeout=5)
 connection.request('POST','/capabilities/v1/result',json.dumps(body),{'authorization':'Bearer workflowd-local','content-type':'application/json'})
 response=connection.getresponse()
 assert response.status==status,(body,response.status)
 response.read(4097)
 connection.close()
receipt=subprocess.check_output(['python3','/opt/workflowd/claude-interactive.py','submit',json.dumps({'operation':'finalize','revision':2})],timeout=10)
assert json.loads(receipt)=={'revision':2}
pathlib.Path('/workdir/finalization-receipt.json').write_bytes(receipt)
print(receipt.decode())`)}`,
          description: "Request finalization of the corrected candidate through run authority",
        },
      ])
    finalResponse = Promise.withResolvers()
    const resumedControl = new PassThrough()
    const resumedFinish = (async () => {
      if (application) return
      await finalResponse.promise
      await delay(1000)
      resumedControl.write('{"operation":"finish"}\n')
    })()
    try {
      assert.equal(
        await (application
          ? application.execute(request, resumedControl, (value) => events.push(value))
          : superviseNative({
              directory,
              request,
              backend,
              control: resumedControl,
              event(value) {
                events.push(value)
                assert.ok(["started", "closed"].includes(value.event))
              },
            })),
        "completed",
      )
      await resumedFinish
    } finally {
      resumedControl.destroy()
    }
    assert.ok(application ? sequence >= 10 && sequence <= 11 : sequence === 10)
    assert.ok(application ? results.length >= 8 && results.length <= 9 : results.length === 8)
    assert.ok(!JSON.stringify(results).includes(request.nonce))
    assert.ok(!JSON.stringify(results).includes(request.container))
    assert.ok(!JSON.stringify(results).includes("native-supervisor.mjs"))
    if (adapter) {
      const history = JSON.stringify(requests.filter((body) => body.tools?.length)[8])
      for (const prompt of [initialPrompt, request.prompt])
        assert.equal(history.split(JSON.stringify(prompt).slice(1, -1)).length - 1, 1)
    } else {
      const history = requests
        .filter((body) => body.tools?.length)[8]
        .messages.flatMap((message) => message.content)
      assert.equal(
        history.filter((item) =>
          application ? item.text?.endsWith(initialPrompt) : item.text === initialPrompt,
        ).length,
        1,
      )
      assert.equal(history.filter((item) => item.text === request.prompt).length, 1)
    }
    assert.ok(
      results.every((result) => !result.is_error),
      JSON.stringify(results),
    )
    assert.equal(revision, 2)
    assert.deepEqual(candidate, completion)
    const privateOutputs = JSON.stringify(results)
    for (const value of canaries) {
      assert.ok(privateOutputs.includes(JSON.stringify(value).slice(1, -1)))
      assert.ok(!JSON.stringify(events).includes(value))
      assert.ok(!JSON.stringify(candidate).includes(value))
    }
    const first = requests.find((body) => body.tools?.length)
    assert.equal(
      adapter
        ? nativeClient === "codex"
          ? first.reasoning.effort
          : first.reasoning_effort
        : first.output_config?.effort,
      "high",
    )
    const invocation = JSON.parse(await readFile(`${directory}/invocation.json`, "utf8"))
    assert.equal(invocation.state, "stopped")
    const stopped = JSON.parse(
      await engine.command(["inspect", `workflowd-native-${request.container}`]),
    )[0]
    assert.equal(stopped.State.Running, false)
    const options = {
      root,
      directory,
      invocation,
      request: { nonce: request.nonce, session: request.session, completion },
      backend,
      command,
      tooling,
    }
    const remoteCapture = application ? await application.capture() : undefined
    const captured = await captureNativeResult(options)
    assert.equal(await captureNativeResult(options), captured)
    const metadata = JSON.parse(captured)
    if (remoteCapture) assert.deepEqual(metadata, remoteCapture)
    assert.equal(metadata.sourceSha, sourceSha)
    assert.equal(metadata.title, completion.title)
    await command([
      "/bin/git",
      "-C",
      "source.git",
      "fetch",
      `${root}/result/result.bundle`,
      metadata.resultSha,
    ])
    assert.equal(
      await command(["/bin/git", "-C", "source.git", "show", `${metadata.resultSha}:result.txt`]),
      "Actual native container tool result",
    )
    if (application)
      assert.deepEqual(
        JSON.parse(
          await command([
            "/bin/git",
            "-C",
            "source.git",
            "show",
            `${metadata.resultSha}:finalization-receipt.json`,
          ]),
        ),
        { revision: 2 },
      )
    assert.match(
      await command([
        "/bin/git",
        "-C",
        "source.git",
        "show",
        `${metadata.resultSha}:isolation.txt`,
      ]),
      /^uid=1000 gid=1000 capabilities=0 no_new_privileges=1/,
    )
    assert.equal(
      await command(["/bin/git", "-C", "source.git", "rev-parse", `${metadata.resultSha}^`]),
      sourceSha,
    )
    await backend.remove()
    if (application) {
      assert.equal((await application.candidate()).frozen, 1)
      await application.close()
      application = null
      await new Promise((resolve) => server.close(resolve))
      await new Promise((resolve) => server.listen(`${root}/gateway.sock`, resolve))
    }
    const completedSequence = sequence
    const cohort = []
    try {
      // Two simultaneously running UID1000 containers fit within the owned 6GiB
      // fixture. Start sequentially, then cancel the live cohort together.
      for (let member = 0; member < 2; member++) {
        const cancelDirectory = `${root}/cancel-${member}`
        await mkdir(cancelDirectory)
        await copyFile(`${directory}/source.tar`, `${cancelDirectory}/source.tar`)
        const cancelRequest = {
          ...request,
          nonce: randomBytes(32).toString("hex"),
          container: undefined,
          predecessor: null,
          resume: false,
          session: randomUUID(),
          prompt: "Start the synthetic sleeping tool.",
          deadline: Date.now() + 180000,
        }
        cohortSessions.add(cancelRequest.session)
        actions.push([
          "Bash",
          {
            command: `python3 -c ${quote("import os,time;open('/workdir/child.pid','w').write(str(os.getpid()));time.sleep(120)")}`,
            description: "Owned sleeping tool",
          },
        ])
        sequence = 0
        const cancelBackend = makeNativeDockerBackend(
          { directory: cancelDirectory, image, nonce: cancelRequest.nonce },
          engine,
        )
        const cancelControl = new PassThrough()
        const ready = Promise.withResolvers()
        const execution = superviseNative({
          directory: cancelDirectory,
          request: cancelRequest,
          backend: cancelBackend,
          control: cancelControl,
          event(value) {
            if (value.event === "started")
              void (async () => {
                const script =
                  "import pathlib,time;p=pathlib.Path('/workdir/child.pid');deadline=time.monotonic()+5\nwhile not p.exists() and time.monotonic()<deadline: time.sleep(.05)\nprint(p.read_text())"
                const childPid = Number(
                  await engine.command([
                    "exec",
                    `workflowd-native-${cancelRequest.nonce}`,
                    "/bin/python3",
                    "-c",
                    script,
                  ]),
                )
                assert.ok(childPid > 1)
                ready.resolve(childPid)
              })().catch(ready.reject)
          },
        })
        void execution.then(
          () => ready.reject(new Error("Cohort member exited before readiness")),
          ready.reject,
        )
        cohort.push({
          request: cancelRequest,
          backend: cancelBackend,
          control: cancelControl,
          execution,
          ready,
        })
        await ready.promise
      }
      for (const member of cohort) {
        const active = JSON.parse(
          await engine.command(["inspect", `workflowd-native-${member.request.nonce}`]),
        )[0]
        assert.equal(active.State.Running, true)
        assert.ok(active.State.Pid > 0)
      }
      const cancelAt = Date.now()
      for (const member of cohort) member.control.write('{"operation":"cancel"}\n')
      assert.deepEqual(await Promise.all(cohort.map((member) => member.execution)), [
        "cancelled",
        "cancelled",
      ])
      assert.ok(Date.now() - cancelAt < 15000, "Cohort cancellation exceeded bounded shutdown")
      for (const member of cohort) {
        const cancelled = JSON.parse(
          await engine.command(["inspect", `workflowd-native-${member.request.nonce}`]),
        )[0]
        assert.equal(cancelled.State.Running, false)
        assert.equal(cancelled.State.Pid, 0)
        await member.backend.remove()
      }
      await writeFile(
        `${root}/cohort.json`,
        JSON.stringify({
          size: 2,
          simultaneouslyRunning: true,
          joined: true,
          stoppedPids: [0, 0],
          removed: true,
          cancelElapsedMs: Date.now() - cancelAt,
        }),
        { mode: 0o600 },
      )
    } finally {
      for (const member of cohort) member.control.destroy()
      await Promise.all(cohort.map((member) => member.execution))
      cohortSessions.clear()
    }
    const spawnDirectory = `${root}/spawn-fault`
    await mkdir(spawnDirectory)
    await copyFile(`${directory}/source.tar`, `${spawnDirectory}/source.tar`)
    const spawnRequest = {
      ...request,
      nonce: randomBytes(32).toString("hex"),
      container: undefined,
      predecessor: null,
      resume: false,
      session: randomUUID(),
      deadline: Date.now() + 90000,
    }
    const spawnBackend = makeNativeDockerBackend(
      { directory: spawnDirectory, image, nonce: spawnRequest.nonce },
      {
        ...engine,
        spawnCustodian() {
          return spawn("/nonexistent-native-custodian", [], { stdio: ["pipe", "pipe", "pipe"] })
        },
      },
    )
    const spawnControl = new PassThrough()
    try {
      assert.equal(
        await superviseNative({
          directory: spawnDirectory,
          request: spawnRequest,
          backend: spawnBackend,
          control: spawnControl,
          event(value) {
            assert.equal(value.event, "closed")
            assert.equal(value.stopped, true)
          },
        }),
        "operator_required",
      )
      const stopped = JSON.parse(
        await engine.command(["inspect", `workflowd-native-${spawnRequest.nonce}`]),
      )[0]
      assert.equal(stopped.State.Running, false)
      assert.equal(stopped.State.Pid, 0)
    } finally {
      spawnControl.destroy()
      await spawnBackend.remove()
    }
    await writeFile(
      `${root}/receipt.json`,
      JSON.stringify(
        {
          imageId,
          localImageReferenceTranslation: true,
          client: nativeClient,
          interactive: !adapter,
          hostPtyCustody: !adapter,
          applicationProof,
          lifecycleProjection: applicationProof ? "controller-verified-SSH" : "runner-events",
          advisoryForgeryIgnored: true,
          sameSessionResume: true,
          sequence: completedSequence,
          revision,
          events,
          metadata,
          stopped: true,
          removed: true,
          cancelledSleepingTool: true,
          cancellationCohort: 2,
          earlySpawnFailureStopped: true,
          privateCanaryVariants: canaries.length,
        },
        null,
        2,
      ),
    )
  }
} finally {
  gitDaemon?.kill("SIGTERM")
  await gitClosed
  if (application) await application.close()
  control.destroy()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await writeFile(`${root}/requests.json`, JSON.stringify(requests))
  await writeFile(`${root}/tool-results.json`, JSON.stringify(results))
  await writeFile(`${root}/events.json`, JSON.stringify(events))
}
