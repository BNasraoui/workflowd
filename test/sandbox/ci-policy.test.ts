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
