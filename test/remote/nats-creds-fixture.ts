import { nkeys } from "@nats-io/nats-core"

/**
 * Mints a self-contained NATS decentralized-authorization world for tests:
 * an operator, a system account, an application account with JetStream
 * enabled, and per-identity users whose subject permissions live in their
 * signed user JWTs. This is what `nsc` would produce, minted directly with
 * the bundled nkeys library so tests need no external tooling.
 */

type KeyPair = ReturnType<typeof nkeys.createUser>

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

const base64Url = (data: Uint8Array | string): string => Buffer.from(data).toString("base64url")

const encodeJwt = (claims: Record<string, unknown>, issuer: KeyPair): string => {
  const header = { typ: "JWT", alg: "ed25519-nkey" }
  const body = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`
  const signature = issuer.sign(textEncoder.encode(body))
  return `${body}.${base64Url(signature)}`
}

const claimsBase = (issuer: KeyPair, subject: KeyPair, name: string) => ({
  jti: crypto.randomUUID().replaceAll("-", "").toUpperCase(),
  iat: Math.floor(Date.now() / 1000),
  iss: issuer.getPublicKey(),
  sub: subject.getPublicKey(),
  name,
})

const accountLimits = {
  subs: -1,
  data: -1,
  payload: -1,
  imports: -1,
  exports: -1,
  wildcards: true,
  conn: -1,
  leaf: -1,
} as const

const jetStreamLimits = {
  mem_storage: -1,
  disk_storage: -1,
  streams: -1,
  consumer: -1,
} as const

type UserPermissions = {
  readonly publishAllow: ReadonlyArray<string>
  readonly subscribeAllow: ReadonlyArray<string>
}

export const formatCreds = (jwt: string, seed: string): string =>
  [
    "-----BEGIN NATS USER JWT-----",
    jwt,
    "------END NATS USER JWT------",
    "",
    "-----BEGIN USER NKEY SEED-----",
    seed,
    "------END USER NKEY SEED------",
    "",
  ].join("\n")

const mintUserCreds = (account: KeyPair, name: string, permissions: UserPermissions): string => {
  const user = nkeys.createUser()
  const jwt = encodeJwt(
    {
      ...claimsBase(account, user, name),
      nats: {
        pub: { allow: [...permissions.publishAllow] },
        sub: { allow: [...permissions.subscribeAllow] },
        subs: -1,
        data: -1,
        payload: -1,
        type: "user",
        version: 2,
      },
    },
    account,
  )
  return formatCreds(jwt, textDecoder.decode(user.getSeed()))
}

export type PermissionedBroker = {
  /** nats-server configuration enforcing the minted operator world. */
  readonly serverConfig: string
  /** Coordinator identity: publish commands, full JetStream API, inbox replies. */
  readonly coordinatorCreds: string
  /** Runner identity scoped to one host's consumer and the shared result subject. */
  readonly runnerCreds: (hostId: string) => string
}

export const mintPermissionedBroker = (): PermissionedBroker => {
  const operator = nkeys.createOperator()
  const systemAccount = nkeys.createAccount()
  const applicationAccount = nkeys.createAccount()

  const systemAccountJwt = encodeJwt(
    {
      ...claimsBase(operator, systemAccount, "SYS"),
      nats: {
        limits: accountLimits,
        default_permissions: { pub: {}, sub: {} },
        type: "account",
        version: 2,
      },
    },
    operator,
  )
  const applicationAccountJwt = encodeJwt(
    {
      ...claimsBase(operator, applicationAccount, "WORKFLOWD"),
      nats: {
        limits: { ...accountLimits, ...jetStreamLimits },
        default_permissions: { pub: {}, sub: {} },
        type: "account",
        version: 2,
      },
    },
    operator,
  )
  const operatorJwt = encodeJwt(
    {
      ...claimsBase(operator, operator, "test-operator"),
      nats: {
        system_account: systemAccount.getPublicKey(),
        type: "operator",
        version: 2,
      },
    },
    operator,
  )

  const serverConfig = [
    "port: 4222",
    'jetstream { store_dir: "/tmp/nats-jetstream" }',
    `operator: ${operatorJwt}`,
    `system_account: ${systemAccount.getPublicKey()}`,
    "resolver: MEMORY",
    "resolver_preload {",
    `  ${systemAccount.getPublicKey()}: ${systemAccountJwt}`,
    `  ${applicationAccount.getPublicKey()}: ${applicationAccountJwt}`,
    "}",
    "",
  ].join("\n")

  return {
    serverConfig,
    coordinatorCreds: mintUserCreds(applicationAccount, "workflowd-coordinator", {
      publishAllow: ["workflowd.v1.commands.*", "$JS.API.>", "$JS.ACK.WORKFLOWD_RESULTS_V1.>"],
      subscribeAllow: ["_INBOX.>"],
    }),
    runnerCreds: (hostId: string) =>
      mintUserCreds(applicationAccount, `workflowd-runner-${hostId}`, {
        publishAllow: [
          "workflowd.v1.results",
          "$JS.API.INFO",
          `$JS.API.CONSUMER.INFO.WORKFLOWD_COMMANDS_V1.runner-${hostId}`,
          `$JS.API.CONSUMER.CREATE.WORKFLOWD_COMMANDS_V1.runner-${hostId}`,
          `$JS.API.CONSUMER.CREATE.WORKFLOWD_COMMANDS_V1.runner-${hostId}.>`,
          `$JS.API.CONSUMER.DURABLE.CREATE.WORKFLOWD_COMMANDS_V1.runner-${hostId}`,
          `$JS.API.CONSUMER.MSG.NEXT.WORKFLOWD_COMMANDS_V1.runner-${hostId}`,
          `$JS.ACK.WORKFLOWD_COMMANDS_V1.runner-${hostId}.>`,
        ],
        subscribeAllow: ["_INBOX.>"],
      }),
  }
}
