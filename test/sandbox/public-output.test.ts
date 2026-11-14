import { expect, test } from "bun:test"
import { Schema } from "effect"
import { serializePublicStatus } from "../../src/sandbox/public-output"
import { publicBootstrapConfiguration } from "../../deploy/sandbox/public-output.mjs"
import { resolve } from "node:path"
import { mkdtemp, readdir, rm, readFile, stat } from "node:fs/promises"

const publicReceipt = Schema.Struct({
  version: Schema.Literal(1),
  stage: Schema.Literals(["setup", "bootstrap", "audit", "transport", "cleanup", "test"]),
  outcome: Schema.Literals(["ok", "failed", "cancelled"]),
  reason: Schema.Literals(["none", "refused", "unavailable", "timeout", "capacity"]),
  count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000000000 })),
  correlationId: Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/)),
})
const validateReceipt = (text: string) =>
  Schema.decodeUnknownSync(publicReceipt, { onExcessProperty: "error" })(JSON.parse(text))

test("Bun, Node and compiled imports stay inert with CLI-shaped arguments and preserve caller exit", async () => {
  const root = await mkdtemp(`${process.env.TMPDIR}/wfd-public-import-`)
  try {
    const entry = `${root}/import.mjs`
    const binary = `${root}/compiled`
    await Bun.write(
      entry,
      `import { serializePublicStatus } from ${JSON.stringify(resolve("deploy/sandbox/public-output.mjs"))};
if (typeof serializePublicStatus !== "function") throw new Error("missing export");
process.exitCode = 23;`,
    )
    const built = await Bun.build({ entrypoints: [entry], compile: { outfile: binary } })
    expect(built.success).toBe(true)
    for (const command of [[process.execPath, entry], ["node", entry], [binary]]) {
      const child = Bun.spawn(
        [
          ...command,
          "test",
          "--",
          process.execPath,
          "-e",
          `await Bun.write(${JSON.stringify(`${root}/unexpected-child`)}, "spawned")`,
        ],
        { env: { PATH: process.env.PATH, TMPDIR: root }, stdout: "pipe", stderr: "pipe" },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ command, code, stdout, stderr }).toEqual({
        command,
        code: 23,
        stdout: "",
        stderr: "",
      })
      expect((await readdir(root)).sort()).toEqual(["compiled", "import.mjs"])
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

test("Node direct CLI retains the prescribed public receipt and owner-only private capture", async () => {
  const root = await mkdtemp(`${process.env.TMPDIR}/wfd-node-public-`)
  try {
    const child = Bun.spawn(
      [
        "node",
        resolve("deploy/sandbox/public-output.mjs"),
        "test",
        "--",
        "node",
        "-e",
        'console.error("private-node-canary")',
      ],
      { env: { PATH: process.env.PATH, TMPDIR: root }, stdout: "pipe", stderr: "pipe" },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code).toBe(0)
    expect(stderr).toBe("")
    expect(validateReceipt(stdout)).toMatchObject({
      stage: "test",
      outcome: "ok",
      reason: "none",
      count: 0,
    })
    const directories = await readdir(root)
    expect(directories).toHaveLength(1)
    const directory = `${root}/${directories[0]}`
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(`${directory}/capture.log`)).mode & 0o777).toBe(0o600)
    expect(await readFile(`${directory}/capture.log`, "utf8")).toBe("private-node-canary\n")
    expect(await readFile(`${directory}/receipt.json`, "utf8")).toBe(stdout.trim())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("controlled receipts exclude arbitrary raw, encoded, chunked and multiline private fields", () => {
  const secret = "fixture-private-canary\n::error::not-an-annotation"
  const variants = [
    secret,
    Buffer.from(secret).toString("base64"),
    Buffer.from(secret).toString("hex"),
    encodeURIComponent(secret),
    [secret.slice(0, 9), secret.slice(9)].join(""),
  ]
  for (const value of variants) {
    const status = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
      JSON.parse(
        serializePublicStatus({
          stage: "audit",
          outcome: "ok",
          reason: "none",
          count: 2,
          command: value,
          error: value,
          debug: value,
          claims: value,
        }),
      ),
    )
    expect(Object.keys(status).sort()).toEqual([
      "correlationId",
      "count",
      "outcome",
      "reason",
      "stage",
      "version",
    ])
    expect(status).toMatchObject({
      version: 1,
      stage: "audit",
      outcome: "ok",
      reason: "none",
      count: 2,
    })
    expect(status.correlationId).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.stringify(status)).not.toContain(value)
    expect(() => validateReceipt(JSON.stringify(status))).not.toThrow()
    // Deliberately leaking and fragmented output must fail the same validator
    // used below on real capture output, even for unknown/encoded canaries.
    expect(() => validateReceipt(JSON.stringify({ ...status, diagnostic: value }))).toThrow()
    expect(() =>
      validateReceipt([JSON.stringify(status), value.slice(0, 9), value.slice(9)].join("")),
    ).toThrow()
  }
  expect(() =>
    serializePublicStatus({ stage: secret, outcome: "ok", reason: "none", count: 0 }),
  ).toThrow()
})

test("cancelled capture retains bounded private diagnostics and emits one fixed public receipt", async () => {
  const root = await mkdtemp(`${process.env.TMPDIR}/wfd-cancel-public-`)
  const started = `${root}/started`
  const child = Bun.spawn(
    [
      process.execPath,
      resolve("deploy/sandbox/public-output.mjs"),
      "audit",
      "--",
      process.execPath,
      "-e",
      `await Bun.write(${JSON.stringify(started)},"ready"); console.error("fixture-cancel-canary"); setInterval(()=>{},1000)`,
    ],
    { env: { PATH: "/usr/bin:/bin", TMPDIR: root }, stdout: "pipe", stderr: "pipe" },
  )
  const timeout = setTimeout(() => child.kill("SIGKILL"), 2000)
  try {
    while (!(await Bun.file(started).exists())) await Bun.sleep(5)
    child.kill("SIGTERM")
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code).toBe(1)
    expect(stderr).toBe("")
    expect(validateReceipt(stdout)).toMatchObject({
      stage: "audit",
      outcome: "cancelled",
      reason: "unavailable",
    })
    expect(stdout).not.toContain("canary")
    const diagnostic = (await readdir(root)).find((entry) => entry.startsWith("workflowd-private-"))
    expect(await readFile(`${root}/${diagnostic}/receipt.json`, "utf8")).toBe(stdout.trim())
  } finally {
    clearTimeout(timeout)
    child.kill("SIGKILL")
    await child.exited
    await rm(root, { recursive: true, force: true })
  }
}, 3000)

test("R2: exactly two trusted bootstrap fields are public, bounded and single-line", () => {
  expect(
    publicBootstrapConfiguration({
      tailscaleClientId: "fixture-client",
      tailscaleAudience: "https://fixture.invalid/workflowd",
      token: "canary",
      peer: "100.64.0.1",
      debug: "canary",
    }),
  ).toEqual({
    tailscaleClientId: "fixture-client",
    tailscaleAudience: "https://fixture.invalid/workflowd",
  })
  for (const field of ["tailscaleClientId", "tailscaleAudience"])
    for (const value of [
      "",
      "x".repeat(257),
      "fixture\n::error::canary",
      "${agent}",
      "x\rdebug",
      "x\u2028y",
      "x?token=canary",
      "fixture\n",
      "fixture\r",
      "fixture\u2028",
      "fixture\u2029",
    ])
      expect(() =>
        publicBootstrapConfiguration({
          tailscaleClientId: "fixture",
          tailscaleAudience: "fixture",
          [field]: value,
        }),
      ).toThrow("bootstrap configuration refused")
})

test("setup, error and cleanup captures cannot create Actions command files or print child diagnostics", async () => {
  const root = await mkdtemp(`${process.env.TMPDIR}/wfd-public-`)
  try {
    for (const stage of ["setup", "cleanup"])
      for (const exit of [0, 1]) {
        const child = Bun.spawn(
          [
            process.execPath,
            resolve("deploy/sandbox/public-output.mjs"),
            stage,
            "--",
            process.execPath,
            "-e",
            `console.log("fixture-canary\\n::error::fixture-canary");console.error(Buffer.from("fixture-canary").toString("base64")); console.error(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);console.error(Buffer.from(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toString("base64")); if(process.env.GITHUB_OUTPUT) await Bun.write(process.env.GITHUB_OUTPUT,"bad=fixture-canary");process.exit(${exit})`,
          ],
          {
            env: {
              PATH: "/usr/bin:/bin",
              ACTIONS_STEP_DEBUG: "true",
              GITHUB_OUTPUT: `${root}/output`,
              GITHUB_STEP_SUMMARY: `${root}/summary`,
              TMPDIR: root,
              ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-job-credential",
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        expect(code).toBe(exit)
        expect(stderr).toBe("")
        expect(validateReceipt(stdout)).toMatchObject({
          version: 1,
          stage,
          outcome: exit === 0 ? "ok" : "failed",
        })
        expect(stdout).not.toContain("fixture-canary")
        expect(stdout).not.toContain(Buffer.from("fixture-canary").toString("base64"))
      }
    const diagnostics = await readdir(root)
    expect(diagnostics).toHaveLength(4)
    for (const directory of diagnostics) {
      expect(directory).toStartWith("workflowd-private-")
      expect((await stat(`${root}/${directory}`)).mode & 0o777).toBe(0o700)
      expect((await stat(`${root}/${directory}/capture.log`)).mode & 0o777).toBe(0o600)
      expect(await readFile(`${root}/${directory}/capture.log`, "utf8")).toContain("fixture-canary")
      expect(await readFile(`${root}/${directory}/capture.log`, "utf8")).not.toContain(
        "synthetic-job-credential",
      )
      expect(await readFile(`${root}/${directory}/capture.log`, "utf8")).not.toContain(
        Buffer.from("synthetic-job-credential").toString("base64"),
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
