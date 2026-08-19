import { expect, test } from "bun:test"
import { nkeys } from "@nats-io/nats-core"
import { loadRemoteNatsAuth, natsAuthOptions } from "../../src/remote/auth"
import { formatCreds } from "./nats-creds-fixture"

const sampleCreds = formatCreds(
  "eyJ0eXAiOiJKV1QifQ.eyJzdWIiOiJ0ZXN0In0.c2ln",
  new TextDecoder().decode(nkeys.createUser().getSeed()),
)

const exactlyOne =
  "Set exactly one of WORKFLOWD_NATS_TOKEN, WORKFLOWD_NATS_TOKEN_FILE, " +
  "WORKFLOWD_NATS_CREDS, or WORKFLOWD_NATS_CREDS_FILE"

test("auth loads a direct token", async () => {
  const auth = await loadRemoteNatsAuth({ WORKFLOWD_NATS_TOKEN: "secret-token" })
  expect(auth).toEqual({ mode: "token", token: "secret-token" })
})

test("auth loads a token file and trims the trailing newline", async () => {
  const auth = await loadRemoteNatsAuth(
    { WORKFLOWD_NATS_TOKEN_FILE: "/run/credentials/nats-token" },
    async (path) => (path === "/run/credentials/nats-token" ? "file-token\r\n" : "unexpected"),
  )
  expect(auth).toEqual({ mode: "token", token: "file-token" })
})

test("auth loads creds content directly from the environment", async () => {
  const auth = await loadRemoteNatsAuth({ WORKFLOWD_NATS_CREDS: sampleCreds })
  expect(auth).toEqual({ mode: "creds", creds: sampleCreds })
})

test("auth loads a creds file and trims the trailing newline", async () => {
  const auth = await loadRemoteNatsAuth(
    { WORKFLOWD_NATS_CREDS_FILE: "/run/credentials/nats.creds" },
    async () => `${sampleCreds}\n`,
  )
  expect(auth).toEqual({ mode: "creds", creds: sampleCreds })
})

test("auth requires a credential source", async () => {
  await expect(loadRemoteNatsAuth({})).rejects.toThrow(exactlyOne)
})

for (const environment of [
  { WORKFLOWD_NATS_TOKEN: "token", WORKFLOWD_NATS_TOKEN_FILE: "/token" },
  { WORKFLOWD_NATS_TOKEN: "token", WORKFLOWD_NATS_CREDS: "creds" },
  { WORKFLOWD_NATS_TOKEN_FILE: "/token", WORKFLOWD_NATS_CREDS_FILE: "/creds" },
  {
    WORKFLOWD_NATS_TOKEN: "token",
    WORKFLOWD_NATS_TOKEN_FILE: "/token",
    WORKFLOWD_NATS_CREDS: "creds",
    WORKFLOWD_NATS_CREDS_FILE: "/creds",
  },
]) {
  test(`auth rejects simultaneous sources ${Object.keys(environment).join("+")}`, async () => {
    await expect(loadRemoteNatsAuth(environment)).rejects.toThrow(exactlyOne)
  })
}

test("auth treats an empty direct token as unset", async () => {
  await expect(loadRemoteNatsAuth({ WORKFLOWD_NATS_TOKEN: "" })).rejects.toThrow(exactlyOne)
})

test("a systemd drop-in can blank the unit token source and supply creds instead", async () => {
  const auth = await loadRemoteNatsAuth(
    {
      WORKFLOWD_NATS_TOKEN_FILE: "",
      WORKFLOWD_NATS_CREDS_FILE: "/run/credentials/workflowd-runner.service/nats-creds",
    },
    async () => `${sampleCreds}\n`,
  )
  expect(auth).toEqual({ mode: "creds", creds: sampleCreds })
})

test("auth rejects a blank token file path", async () => {
  await expect(loadRemoteNatsAuth({ WORKFLOWD_NATS_TOKEN_FILE: "  " })).rejects.toThrow(
    "WORKFLOWD_NATS_TOKEN_FILE must name a file",
  )
})

test("auth rejects a token file that only holds a newline", async () => {
  await expect(
    loadRemoteNatsAuth({ WORKFLOWD_NATS_TOKEN_FILE: "/token" }, async () => "\n"),
  ).rejects.toThrow("WORKFLOWD_NATS_TOKEN_FILE must not be empty")
})

test("auth reports an unreadable creds file without leaking content", async () => {
  const failure = loadRemoteNatsAuth({ WORKFLOWD_NATS_CREDS_FILE: "/missing.creds" }, async () => {
    throw new Error("ENOENT")
  })
  await expect(failure).rejects.toThrow(
    "Could not read WORKFLOWD_NATS_CREDS_FILE at /missing.creds",
  )
})

test("auth treats an empty creds environment value as unset", async () => {
  await expect(loadRemoteNatsAuth({ WORKFLOWD_NATS_CREDS: "" })).rejects.toThrow(exactlyOne)
})

test("auth rejects creds content that is not in .creds format", async () => {
  await expect(loadRemoteNatsAuth({ WORKFLOWD_NATS_CREDS: "just-a-token" })).rejects.toThrow(
    "WORKFLOWD_NATS_CREDS must contain a NATS user JWT and NKey seed in .creds format",
  )
})

test("token auth connects with the token option and nothing else", () => {
  expect(natsAuthOptions({ mode: "token", token: "secret-token" })).toEqual({
    token: "secret-token",
  })
})

test("creds auth connects with a signing authenticator instead of a token", () => {
  const options = natsAuthOptions({ mode: "creds", creds: sampleCreds })
  expect("token" in options).toBe(false)
  const authenticator = options.authenticator
  if (typeof authenticator !== "function") throw new Error("expected an authenticator function")
  const auth = authenticator("nonce")
  expect(auth).toMatchObject({
    jwt: "eyJ0eXAiOiJKV1QifQ.eyJzdWIiOiJ0ZXN0In0.c2ln",
    nkey: expect.stringMatching(/^U/),
    sig: expect.stringMatching(/./),
  })
})
