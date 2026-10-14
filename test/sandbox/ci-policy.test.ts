import { expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import {
  assertUnprivilegedPrWorkflows,
  assertProtectedPublishAction,
} from "../../src/sandbox/ci-policy"

async function workflows(): Promise<Record<string, string>> {
  const files = await readdir(".github/workflows")
  return Object.fromEntries(
    await Promise.all(
      files.map(
        async (name) => [name, await Bun.file(`.github/workflows/${name}`).text()] as const,
      ),
    ),
  )
}

test("every repository PR workflow has an unprivileged execution path", async () => {
  const files = await workflows()
  expect(() => assertUnprivilegedPrWorkflows(files)).not.toThrow()
})

for (const [before, after] of [
  ["permissions: {}", "permissions: { contents: read }"],
  ["runs-on: ubuntu-24.04", "runs-on: self-hosted"],
  ["git -c credential.helper=", "git -c credential.helper=store"],
  ["github.event.pull_request.head.sha || github.sha", "github.head_ref"],
  ["env -u GITHUB_TOKEN -u INPUT_GITHUB_ACCESS_TOKEN", "env"],
  ["    steps:", "    environment: production\n    steps:"],
  ["    steps:", "    env: { TOKEN: '${{ secrets.WRITE_TOKEN }}' }\n    steps:"],
  ["    steps:", "    steps:\n      - uses: actions/cache@v4"],
  ["--no-update-lock-file", "--recreate-lock-file"],
  ["timeout 900 bash test/agent-image/e2e.sh", "true"],
  ['test "$first" = "$second"', "true"],
  ["github.event_name == 'push' && github.ref == 'refs/heads/main'", "always()"],
]) {
  test(`CI guard rejects image workflow drift: ${before}`, async () => {
    const files = await workflows()
    expect(() => assertUnprivilegedPrWorkflows(files)).not.toThrow()
    const source = files["agent-image.yml"]!
    files["agent-image.yml"] = source.replace(before!, after!)
    expect(files["agent-image.yml"]).not.toBe(source)
    expect(() => assertUnprivilegedPrWorkflows(files)).toThrow()
  })
}

test("image caller cannot inherit secrets or substitute a reusable dependency", async () => {
  const files = await workflows()
  expect(() => assertUnprivilegedPrWorkflows(files)).not.toThrow()
  const source = files["agent-image-pr.yml"]!
  files["agent-image-pr.yml"] = source.replace("    uses:", "    secrets: inherit\n    uses:")
  expect(() => assertUnprivilegedPrWorkflows(files)).toThrow()
  files["agent-image-pr.yml"] = source.replace("agent-image.yml", "agent-image-publish.yml")
  expect(() => assertUnprivilegedPrWorkflows(files)).toThrow()
  files["agent-image-pr.yml"] = source
  delete files["agent-image.yml"]
  expect(() => assertUnprivilegedPrWorkflows(files)).toThrow()
})

for (const [label, before, after] of [
  ["job token grant", "    permissions: {}", "    permissions: { contents: read }"],
  ["ambient token grant", "permissions: {}", "permissions: { id-token: write }"],
  ["target trigger", "  pull_request:", "  pull_request_target:"],
  ["privileged downstream", "  pull_request:", "  workflow_run:"],
  ["self-hosted runner", "runs-on: ubuntu-latest", "runs-on: self-hosted"],
  ["environment secrets", "    steps:", "    environment: production\n    steps:"],
  [
    "reusable inherited secrets",
    "    steps:",
    "    uses: ./.github/workflows/agent-sandbox.yml\n    secrets: inherit\n    steps:",
  ],
  ["secret expression", "run: ${{ matrix.command }}", "run: echo ${{ secrets.WRITE_TOKEN }}"],
  ["whole credential context", "run: ${{ matrix.command }}", "run: echo '${{ toJSON(github) }}'"],
  ["runtime token", "run: ${{ matrix.command }}", "run: echo $ACTIONS_RUNTIME_TOKEN"],
  [
    "unpinned action",
    "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
    "oven-sh/setup-bun@v2",
  ],
  [
    "local action",
    "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
    "./.github/actions/unsafe",
  ],
  ["Bun shared cache", "no-cache: true", "no-cache: false"],
  ["Node cache", "node-version: 24.11.1", "node-version: 24.11.1\n          cache: npm"],
  ["credential checkout", "git -c credential.helper=", "git -c credential.helper=store"],
  [
    "checkout injection",
    "HEAD_SHA: ${{ github.event.pull_request.head.sha || github.sha }}",
    "HEAD_SHA: ${{ github.head_ref }}",
  ],
  [
    "install scripts",
    "bun install --frozen-lockfile --ignore-scripts",
    "bun install --frozen-lockfile",
  ],
  [
    "CodeQL PR execution",
    "github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'schedule')",
    "always()",
  ],
]) {
  test(`CI guard rejects ${label}`, async () => {
    const files = await workflows()
    const changed = Object.fromEntries(
      Object.entries(files).map(([name, text]) => [name, text.replace(before!, after!)]),
    )
    expect(changed).not.toEqual(files)
    expect(() => assertUnprivilegedPrWorkflows(changed)).toThrow()
  })
}

for (const [label, extra] of [
  ["environment", "environment: agent-publish"],
  ["secret expression", "env: { CANARY: '${{ secrets.PUBLISH_PROBE_CANARY }}' }"],
  ["secret bracket expression", "env: { CANARY: '${{ secrets[\"PUBLISH_PROBE_CANARY\"] }}' }"],
  ["whole secret context", "env: { CANARY: '${{ toJSON(secrets) }}' }"],
  ["inherited secrets", "secrets: inherit"],
]) {
  test(`CI guard rejects ${label} in any non-publisher job, including push-only jobs`, async () => {
    const files = await workflows()
    files["untrusted.yml"] = `on: { push: {} }
permissions: {}
jobs:
  other:
    runs-on: ubuntu-24.04
    ${extra}
    steps: [{ run: 'true' }]
`
    expect(() => assertUnprivilegedPrWorkflows(files)).toThrow()
  })
}

test("CI guard rejects inherited secrets even on the publisher", async () => {
  const files = await workflows()
  files["agent-sandbox-caller.yml"] = files["agent-sandbox-caller.yml"]!.replace(
    "  agent-publish:",
    "  agent-publish:\n    secrets: inherit",
  )
  expect(() => assertUnprivilegedPrWorkflows(files)).toThrow()
})

test("CI guard rejects a publish environment inside a reusable workflow", async () => {
  const files = await workflows()
  files["agent-sandbox.yml"] += "\n  agent-publish:\n    environment: agent-publish\n"
  expect(() => assertUnprivilegedPrWorkflows(files)).toThrow()
})

test("CI guard rejects ambient workflow secrets outside the publisher job", async () => {
  const files = await workflows()
  files["agent-sandbox-caller.yml"] += "\nenv: { CANARY: '${{ secrets.PUBLISH_PROBE_CANARY }}' }\n"
  expect(() => assertUnprivilegedPrWorkflows(files)).toThrow()
})

for (const replacement of [
  "env: { KEY: '${{ secrets.GHETTIMONSTER_PRIVATE_KEY }}' }\n    steps:",
  "steps:\n      - run: echo '${{ secrets.GHETTIMONSTER_PRIVATE_KEY }}'",
])
  test("publisher key cannot escape the composite input", async () => {
    const files = await workflows()
    files["agent-sandbox-caller.yml"] = files["agent-sandbox-caller.yml"]!.replace(
      "    steps:",
      "    " + replacement,
    )
    expect(() => assertUnprivilegedPrWorkflows(files)).toThrow()
  })

test("publisher guard rejects key consumers outside the reviewed token step", async () => {
  const source = await Bun.file(".github/actions/agent-publish/action.yml").text()
  expect(() => assertProtectedPublishAction(source)).not.toThrow()
  for (const changed of [
    source.replace(" validate", " publish"),
    source.replace(
      "GATE_ACTOR_ID:",
      "KEY: ${{ inputs.publisher-private-key }}\n        GATE_ACTOR_ID:",
    ),
    source.replace("skip-token-revoke: false", "skip-token-revoke: true"),
  ])
    expect(() => assertProtectedPublishAction(changed)).toThrow()
})

for (const reference of [
  "main",
  "v1",
  "${{ github.sha }}",
  "a".repeat(39),
  "./trusted/.github/actions/agent-publish",
]) {
  test(`publisher refuses unpinned action: ${reference}`, async () => {
    const files = await workflows()
    const uses = reference.startsWith("./")
      ? reference
      : `BNasraoui/workflowd/.github/actions/agent-publish@${reference}`
    files["publisher.yml"] = `on: { push: {} }
jobs:
  agent-publish:
    steps:
      - uses: ${uses}
        with:
          publisher-private-key: \${{ secrets.GHETTIMONSTER_PRIVATE_KEY }}
`
    expect(() => assertUnprivilegedPrWorkflows(files)).toThrow()
  })
}

for (const step of [
  "uses: actions/cache@" + "a".repeat(40),
  "uses: actions/cache/restore@" + "a".repeat(40),
  "uses: actions/cache/save@" + "a".repeat(40),
  "uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020\n        with: { cache: npm }",
  "uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6\n        with: { no-cache: false }",
  "run: gh cache restore untrusted",
  "uses: vendor/cache-helper@" + "a".repeat(40),
]) {
  test(`publisher refuses cache-capable extra steps: ${step}`, async () => {
    const files = await workflows()
    files["agent-sandbox-caller.yml"] += `\n      - ${step}\n`
    expect(() => assertUnprivilegedPrWorkflows(files)).toThrow()
  })
}

for (const environment of [
  "ben-merge-approval",
  "{ name: ben-merge-approval }",
  "BEN-MERGE-APPROVAL",
  "${{ vars.DEPLOY_ENVIRONMENT }}",
  "{ name: '${{ inputs.environment }}' }",
])
  test(`publisher cannot select the protected approval environment: ${environment}`, async () => {
    const files = await workflows()
    files["agent-sandbox-caller.yml"] = files["agent-sandbox-caller.yml"]!.replace(
      "environment: agent-publish",
      `environment: ${environment}`,
    )
    expect(() => assertUnprivilegedPrWorkflows(files)).toThrow(
      "Publisher environment must be agent-publish",
    )
  })
