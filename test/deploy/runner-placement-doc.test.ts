import { expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"

/**
 * docs/runner-placement.md against what runs: each environment variable, configuration key,
 * noscope provider file and systemd unit that the procedure names is one that the code, the
 * workflows or deploy/ hold. A name in angle brackets is a placeholder and is not checked.
 */

const doc = resolve("docs/runner-placement.md")

/** Each file below `directory`, recursively, whose name passes `keep`. */
async function files(directory: string, keep: (name: string) => boolean): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(resolve(directory), { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...(await files(path, keep)))
    else if (keep(entry.name)) found.push(path)
  }
  return found
}

/** The text of the code, the workflows and deploy/: where each name must be held. */
async function holders() {
  const paths = [
    ...(await files("src", (name) => name.endsWith(".ts"))),
    ...(await files("deploy", () => true)),
    ...(await files(".github/workflows", (name) => /\.ya?ml$/.test(name))),
  ]
  return (await Promise.all(paths.map((path) => readFile(resolve(path), "utf8")))).join("\n")
}

/** The text of the document without its placeholders. */
async function documentText() {
  return (await readFile(doc, "utf8")).replace(/<[^<>\n]*>/g, "")
}

const unique = (values: Iterable<string>) => [...new Set(values)].sort()

/** The environment variables that the document names. */
const variables = (text: string) =>
  unique(text.match(/\b(?:WORKFLOWD|SANDBOX|TS_AGENT|GITHUB|ACTIONS)_[A-Z0-9_]*[A-Z0-9]\b/g) ?? [])

/**
 * The configuration keys that the document names: each word in backticks of the form of a key
 * (`login.directory`, `credentialRole`, `noscope.configHome`), and each quoted JSON key.
 */
const configKeys = (text: string) =>
  unique([
    ...[...text.matchAll(/`([a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*)`/g)]
      .map((match) => match[1]!)
      .filter((key) => key.includes(".") || /[A-Z]/.test(key))
      .filter((key) => !/\.(?:md|ts|mjs|toml|yml|service|sock|db|sh|json)$/.test(key)),
    ...[...text.matchAll(/"([A-Za-z][A-Za-z0-9]*)":/g)].map((match) => match[1]!),
  ])

/** The noscope provider files that the document names. */
const providerFiles = (text: string) =>
  unique([...text.matchAll(/(?<![$\w-])([a-z][a-z0-9-]*)\.toml\b/g)].map((match) => match[1]!))

/** The systemd units that the document names; `listen.service` is a configuration key. */
const units = (text: string) =>
  unique(
    [...text.matchAll(/(?<![<@\w.-])([a-z][a-z0-9-]*)\.service\b/g)]
      // A section of the configuration (`listen.socket`) with a `service` field is no unit.
      .filter((match) => !configKeys(text).some((key) => key.startsWith(`${match[1]}.`)))
      .map((match) => match[1]!),
  )

/** Keys of the tailnet policy file, which the owner edits and Tailscale reads. */
const tailnetPolicyKeys = ["autoApprovers.services", "tagOwners"]

test("each environment variable that the document names is one that the code, the workflows or deploy/ hold", async () => {
  const held = await holders()
  const named = variables(await documentText())
  expect(named.length).toBeGreaterThan(5)
  expect(named.filter((name) => !new RegExp(`\\b${name}\\b`).test(held))).toEqual([])
})

test("each configuration key that the document names is a key of the code's configuration or policy", async () => {
  const held = await holders()
  const named = configKeys(await documentText()).filter((key) => !tailnetPolicyKeys.includes(key))
  expect(named).toContain("noscope.configHome")
  // Each part of a key is a field that the code reads: `field:` in a schema or `"field"` in JSON.
  const missing = named.filter((key) =>
    key
      .split(".")
      .some(
        (part) =>
          !new RegExp(`(?:^|[\\s{,"])${part}"?\\??\\s*:`, "m").test(held) &&
          !new RegExp(`\\.${part}\\b`).test(held),
      ),
  )
  expect(missing).toEqual([])
})

test("each noscope provider file that the document names is a template of deploy/noscope/", async () => {
  const templates = await readdir(resolve("deploy/noscope"))
  const named = providerFiles(await documentText())
  expect(named).toContain("provider-access")
  expect(named.filter((name) => !templates.includes(`${name}.toml`))).toEqual([])
})

test("the document installs each noscope provider that the gateway mints through, at the provider directory of the example's configHome", async () => {
  const service = await readFile(resolve("src/capability-gateway/service.ts"), "utf8")
  const minted = unique(
    [...service.matchAll(/mintCapability\([^)]*?"(run-capability|provider-access)"/gs)].map(
      (match) => match[1]!,
    ),
  )
  expect(minted).toEqual(["provider-access", "run-capability"])
  const example = await readFile(resolve("deploy/gateway.env.example"), "utf8")
  const configHome = /"configHome":"([^"]+)"/.exec(example)?.[1]
  expect(configHome).toBeDefined()
  const text = await readFile(doc, "utf8")
  for (const name of minted) {
    expect({ name, template: text.includes(`deploy/noscope/${name}.toml`) }).toEqual({
      name,
      template: true,
    })
    expect({
      name,
      installed: text.includes(`${configHome}/noscope/providers/${name}.toml`),
    }).toEqual({ name, installed: true })
  }
})

test("each import-login and each credentialRole of the document and of the example environment names a provider of custody's table", async () => {
  const custody = await readFile(resolve("src/capability-gateway/custody.ts"), "utf8")
  const table = /const providers = \{\n((?: {2}.*\n)+?)\}/.exec(custody)?.[1] ?? ""
  const providers = [...table.matchAll(/^ {2}([a-z][a-z0-9-]*): \{/gm)].map((match) => match[1]!)
  expect(providers).toEqual(["claude"])
  const text = await readFile(doc, "utf8")
  const imports = [...text.matchAll(/import-login ([^\s`]+)/g)].map((match) => match[1]!)
  const example = await readFile(resolve("deploy/gateway.env.example"), "utf8")
  const roles = [
    ...[...text.matchAll(/`credentialRole`: keep `([^`]*)`/g)],
    ...[...example.matchAll(/"credentialRole":"([^"]*)"/g)],
  ].map((match) => match[1]!)
  expect(imports.length).toBeGreaterThan(0)
  expect(roles.length).toBeGreaterThan(0)
  expect([...imports, ...roles].filter((name) => !providers.includes(name))).toEqual([])
})

test("each systemd unit that the document names is a unit of deploy/systemd/", async () => {
  const deployed = await readdir(resolve("deploy/systemd"))
  const named = units(await documentText())
  expect(named).toContain("workflowd-gateway")
  expect(named.filter((name) => !deployed.includes(`${name}.service`))).toEqual([])
})

test("the document's name checks find a name that nothing holds", () => {
  expect(variables("Set `WORKFLOWD_GATEWAY_LOGIN` and `SANDBOX_GATEWAY_URL`.")).toEqual([
    "SANDBOX_GATEWAY_URL",
    "WORKFLOWD_GATEWAY_LOGIN",
  ])
  expect(configKeys('Keep `login.path` and `gitRead`, and `"repositoryOwnerId": 1`.')).toEqual([
    "gitRead",
    "login.path",
    "repositoryOwnerId",
  ])
  expect(providerFiles("Copy deploy/noscope/run-capability.toml and access.toml.")).toEqual([
    "access",
    "run-capability",
  ])
  expect(units("Start `workflowd-gateway.service`, not `user@1000.service`.")).toEqual([
    "workflowd-gateway",
  ])
})
