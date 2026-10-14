import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { identityGuard, guardedHook } from "../src/agent-git/hooks"
import { Effect } from "effect"
import { loadConfig } from "../src/config"
import { gitAgentRunWorktrees } from "../src/kernel/agent-run-worktrees"

const run = async (cwd: string, args: string[], env: Record<string, string> = {}) => {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Agent",
      GIT_AUTHOR_EMAIL: "agent@example.test",
      GIT_COMMITTER_NAME: "Agent",
      GIT_COMMITTER_EMAIL: "agent@example.test",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    code: await child.exited,
    output: (await new Response(child.stdout).text()) + (await new Response(child.stderr).text()),
  }
}
const ok = async (cwd: string, args: string[]) => {
  const result = await run(cwd, args)
  expect(result).toMatchObject({ code: 0 })
  return result.output.trim()
}

const identity = {
  WORKFLOWD_AGENT_GIT_NAME: "Workflow Agent",
  WORKFLOWD_AGENT_GIT_EMAIL: "agent@example.test",
  WORKFLOWD_AGENT_GIT_BLOCKED_EMAILS: "blocked@example.test,other@example.test",
}
const automation = {
  GITHUB_APP_ID: "123",
  GITHUB_PRIVATE_KEY_PATH: "/unused",
  GITHUB_WEBHOOK_SECRET: "secret",
  WORKFLOWD_PR_REPOSITORIES: '[{"repository":"example/repo","installationId":1}]',
  WORKFLOWD_ALLOWED_INSTALLATION_ACCOUNT_IDS: "1",
  OPENCODE_SERVER_PASSWORD: "secret",
  WORKFLOWD_REVIEW_OPENCODE_PASSWORD: "review-secret",
  WORKFLOWD_OPENCODE_ATTACH_URL: "http://localhost:4096",
  WORKFLOWD_AGENT_RUN_TOKEN: "test-token",
  WORKFLOWD_AGENT_RUN_REPOSITORIES: "repo=/tmp/repo",
}
test("automation with agent runs fails closed without a complete git identity", async () => {
  for (const partial of [
    {},
    { WORKFLOWD_AGENT_GIT_NAME: "Agent" },
    { WORKFLOWD_AGENT_GIT_EMAIL: "agent@example.test" },
  ])
    await expect(loadConfig({ ...automation, ...partial })).rejects.toThrow("WORKFLOWD_AGENT_GIT")
})
test("loads host identity and normalizes the blocklist without including values in errors", async () => {
  const config = await loadConfig({ ...automation, ...identity })
  expect(config.agentGit).toEqual({
    name: "Workflow Agent",
    email: "agent@example.test",
    blockedEmails: ["blocked@example.test", "other@example.test"],
  })
  await expect(
    loadConfig({ ...automation, ...identity, WORKFLOWD_AGENT_GIT_EMAIL: "BLOCKED@example.test" }),
  ).rejects.toThrow("blocked")
})

test("worktree guard blocks explicit author and committer at commit and push, preserves repository hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflowd-git-"))
  const repo = join(root, "repo"),
    directory = join(root, "worktree")
  try {
    await mkdir(repo)
    await ok(repo, ["init", "-b", "main"])
    await ok(repo, [
      "commit",
      "--allow-empty",
      "--author=Historical <blocked@example.test>",
      "-m",
      "seed",
    ])
    await ok(repo, ["init", "--bare", "-b", "main", join(root, "remote")])
    await ok(repo, ["remote", "add", "origin", join(root, "remote")])
    await ok(repo, ["push", "origin", "main"])
    await mkdir(join(repo, ".hooks"))
    await writeFile(join(repo, ".hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o700 })
    await ok(repo, ["config", "core.hooksPath", join(repo, ".hooks")])
    const config = await loadConfig({ WORKFLOWD_MODE: "execution", ...identity })
    await Effect.runPromise(
      gitAgentRunWorktrees.create({
        repository: repo,
        directory,
        branch: "agent",
        git: config.agentGit,
      }),
    )
    const blocked = await run(directory, [
      "commit",
      "--allow-empty",
      "--author=Blocked <blocked@example.test>",
      "-m",
      "blocked",
    ])
    expect(blocked.code).not.toBe(0)
    expect(blocked.output).toContain("workflowd: blocked git identity")
    expect(
      (
        await run(directory, ["commit", "--allow-empty", "-m", "committer"], {
          GIT_COMMITTER_EMAIL: "blocked@example.test",
        })
      ).code,
    ).not.toBe(0)
    await ok(directory, ["commit", "--allow-empty", "-m", "allowed"])
    await ok(directory, ["push", "origin", "HEAD:refs/heads/agent"])
    // Seed an unsafe commit via an explicit hook bypass to exercise the independent push guard.
    await ok(directory, [
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--allow-empty",
      "--author=Blocked <blocked@example.test>",
      "-m",
      "unsafe history",
    ])
    for (const ref of ["agent", "new-branch"]) {
      const pushed = await run(directory, ["push", "origin", `HEAD:refs/heads/${ref}`])
      expect(pushed.code).not.toBe(0)
      expect(pushed.output).toContain("workflowd: blocked git identity")
    }
    await ok(directory, ["reset", "--hard", "HEAD~1"])
    const unsafeCommitter = await run(
      directory,
      ["-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "unsafe committer"],
      { GIT_COMMITTER_EMAIL: "BLOCKED@example.test" },
    )
    expect(unsafeCommitter.code).toBe(0)
    expect((await run(directory, ["push", "origin", "HEAD:refs/heads/agent"])).code).not.toBe(0)
    await ok(directory, ["reset", "--hard", "HEAD~1"])
    await Effect.runPromise(
      gitAgentRunWorktrees.create({
        repository: repo,
        directory,
        branch: "agent",
        git: config.agentGit,
      }),
    )
    expect(
      (
        await run(directory, [
          "commit",
          "--no-verify",
          "--allow-empty",
          "--author=Blocked <blocked@example.test>",
          "-m",
          "retry",
        ])
      ).code,
    ).not.toBe(0)
    await writeFile(
      join(repo, ".hooks", "post-commit"),
      "#!/bin/sh\necho post-commit-forwarded >&2\n",
      { mode: 0o700 },
    )
    expect((await run(directory, ["commit", "--allow-empty", "-m", "forward"])).output).toContain(
      "post-commit-forwarded",
    )
    await writeFile(
      join(repo, ".hooks", "pre-push"),
      '#!/bin/sh\nread local_ref local_sha remote_ref remote_sha\n[ "$remote_ref" = refs/heads/agent ] || exit 1\necho push-input-forwarded >&2\n',
      { mode: 0o700 },
    )
    expect((await run(directory, ["push", "origin", "HEAD:refs/heads/agent"])).output).toContain(
      "push-input-forwarded",
    )

    await writeFile(
      join(repo, ".hooks", "pre-commit"),
      "#!/bin/sh\necho repository-gate >&2\nexit 1\n",
      { mode: 0o700 },
    )
    expect((await run(directory, ["commit", "--allow-empty", "-m", "gate"])).output).toContain(
      "repository-gate",
    )
    expect(await ok(repo, ["config", "--get", "core.hooksPath"])).toBe(join(repo, ".hooks"))
    const hooks = await ok(directory, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "hooks",
    ])
    await rm(join(hooks, "blocked-emails"))
    expect(
      (await run(directory, ["commit", "--allow-empty", "-m", "missing policy"])).output,
    ).toContain("workflowd: git identity policy unavailable")
    // Worktree-specific config has higher precedence than a common config include.
    await ok(directory, ["config", "extensions.worktreeConfig", "true"])
    await ok(directory, ["config", "--worktree", "core.hooksPath", join(repo, ".hooks")])
    const overridden = await Effect.runPromise(
      gitAgentRunWorktrees
        .create({ repository: repo, directory, branch: "agent", git: config.agentGit })
        .pipe(Effect.result),
    )
    expect(overridden._tag).toBe("Failure")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.each(["non-git", "checkout", "worktree", "managed"])(
  "Claude resume pins identity and only refreshes managed guards: %s",
  async (kind) => {
    const { makeClaudeCli } = await import("../src/kernel/claude-session")
    const root = await mkdtemp(join(tmpdir(), "claude-git-resume-"))
    const git = {
      name: "Agent",
      email: "agent@example.test",
      blockedEmails: ["blocked@example.test"],
    }
    try {
      let directory = root
      if (kind !== "non-git") {
        await ok(root, ["init", "-b", "main"])
        await ok(root, ["commit", "--allow-empty", "-m", "seed"])
      }
      if (kind === "managed") {
        await ok(root, ["init", "--bare", "-b", "main", join(root, "remote")])
        await ok(root, ["remote", "add", "origin", join(root, "remote")])
        await ok(root, ["push", "origin", "main"])
        directory = join(root, "agent")
        await Effect.runPromise(
          gitAgentRunWorktrees.create({ repository: root, directory, branch: "agent", git }),
        )
        const hooks = await ok(directory, [
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          "hooks",
        ])
        await rm(join(hooks, "blocked-emails"))
      } else if (kind === "worktree") {
        directory = join(root, "operator")
        await ok(root, ["worktree", "add", "-b", "operator", directory])
      }
      const before =
        kind === "non-git" ? undefined : await readFile(join(root, ".git", "config"), "utf8")
      const binary = join(root, "claude-fixture")
      await writeFile(
        binary,
        `#!/bin/sh
prompt=$(cat)
if [ "$prompt" = identity ]; then
  printf '%s\\n' "$GIT_AUTHOR_NAME" "$GIT_AUTHOR_EMAIL" "$GIT_COMMITTER_NAME" "$GIT_COMMITTER_EMAIL"
else
  git commit --allow-empty --author='Blocked <blocked@example.test>' -m blocked
fi
`,
        { mode: 0o700 },
      )
      const port = makeClaudeCli({ binary, git })
      const input = { nativeSessionId: "fixture", directory, timeoutMs: 5000 }
      expect(await Effect.runPromise(port.resume({ ...input, prompt: "identity" }))).toBe(
        "Agent\nagent@example.test\nAgent\nagent@example.test\n",
      )
      if (before !== undefined) {
        expect(await readFile(join(root, ".git", "config"), "utf8")).toBe(before)
        const outcome = await Effect.runPromise(
          port.resume({ ...input, prompt: "commit" }).pipe(Effect.result),
        )
        expect(outcome._tag).toBe(kind === "managed" ? "Failure" : "Success")
        if (outcome._tag === "Failure")
          expect(outcome.failure.cause.message).toContain("workflowd: blocked git identity")
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

test("an empty blocklist permits pushes whose ranges contain no new commits", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflowd-git-empty-"))
  const directory = join(root, "agent")
  try {
    await ok(root, ["init", "-b", "main"])
    await ok(root, ["commit", "--allow-empty", "-m", "seed"])
    await ok(root, ["init", "--bare", "-b", "main", join(root, "remote")])
    await ok(root, ["remote", "add", "origin", join(root, "remote")])
    await ok(root, ["push", "origin", "main"])
    await Effect.runPromise(
      gitAgentRunWorktrees.create({
        repository: root,
        directory,
        branch: "agent",
        git: { name: "Agent", email: "agent@example.test", blockedEmails: [] },
      }),
    )
    await ok(directory, ["push", "origin", "HEAD:refs/heads/agent"])
    const hooks = await ok(directory, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "hooks",
    ])
    expect(await readFile(join(hooks, "blocked-emails"), "utf8")).toBe("")
    // Ignore blank policy lines left by older installations as well.
    await writeFile(join(hooks, "blocked-emails"), "\n")
    await ok(directory, ["push", "origin", "HEAD:refs/heads/another"])
    await ok(directory, ["commit", "--allow-empty", "-m", "new commit"])
    await ok(directory, ["push", "origin", "HEAD:refs/heads/agent"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("identity configuration is optional only when automation dispatch is disabled", async () => {
  expect((await loadConfig({ WORKFLOWD_MODE: "execution" })).agentGit).toBeUndefined()
  expect(
    (
      await loadConfig({
        ...automation,
        WORKFLOWD_AGENT_RUN_TOKEN: undefined,
        WORKFLOWD_AGENT_RUN_REPOSITORIES: undefined,
      })
    ).agentGit,
  ).toBeUndefined()
})

test.each([
  { WORKFLOWD_AGENT_GIT_NAME: "Agent\nInjected" },
  { WORKFLOWD_AGENT_GIT_EMAIL: "not-an-address" },
  { WORKFLOWD_AGENT_GIT_BLOCKED_EMAILS: "blocked@example.test,," },
])(
  "invalid identity configuration is rejected without disclosing configured values",
  async (invalid) => {
    try {
      await loadConfig({ ...automation, ...identity, ...invalid })
      throw new Error("configuration unexpectedly accepted")
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain("WORKFLOWD_AGENT_GIT")
      for (const value of Object.values(invalid)) expect(message).not.toContain(value)
    }
  },
)

test.each([
  ["URL", false],
  ["URL", true],
  ["named remote", false],
  ["named remote", true],
] as const)("new branch push via %s with new blocked author=%j", async (destination, blocked) => {
  const root = await mkdtemp(join(tmpdir(), "workflowd-git-new-ref-"))
  const remote = join(root, "remote")
  const hooks = join(root, ".git", "hooks")
  try {
    await ok(root, ["init", "-b", "main"])
    await ok(root, [
      "commit",
      "--allow-empty",
      "--author=Historical <blocked@example.test>",
      "-m",
      "published",
    ])
    await ok(root, ["init", "--bare", "-b", "main", remote])
    await ok(root, ["remote", "add", "origin", remote])
    await ok(root, ["push", "origin", "main"])
    await ok(root, ["fetch", "origin"])
    expect(await ok(root, ["rev-parse", "origin/main"])).toBe(await ok(root, ["rev-parse", "HEAD"]))
    await ok(root, [
      "commit",
      "--allow-empty",
      `--author=Agent <${blocked ? "blocked" : "agent"}@example.test>`,
      "-m",
      "unpublished",
    ])
    const guard = join(hooks, "identity-guard")
    await writeFile(guard, identityGuard, { mode: 0o700 })
    await writeFile(join(hooks, "blocked-emails"), "blocked@example.test\n")
    await writeFile(join(hooks, "pre-push"), guardedHook(guard, "pre-push", join(root, "unused")), {
      mode: 0o700,
    })
    await ok(root, ["config", "core.hooksPath", hooks])
    const result = await run(root, [
      "push",
      destination === "URL" ? pathToFileURL(remote).href : "origin",
      "HEAD:refs/heads/new-branch",
    ])
    if (blocked) {
      expect(result.code).not.toBe(0)
      expect(result.output).toContain("workflowd: blocked git identity")
      expect((await run(remote, ["rev-parse", "--verify", "refs/heads/new-branch"])).code).not.toBe(
        0,
      )
    } else {
      expect(result.code).toBe(0)
      expect(await ok(remote, ["rev-parse", "refs/heads/new-branch"])).toBe(
        await ok(root, ["rev-parse", "HEAD"]),
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
