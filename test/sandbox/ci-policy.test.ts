import { expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { assertUnprivilegedPrWorkflows } from "../../src/sandbox/ci-policy"

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
