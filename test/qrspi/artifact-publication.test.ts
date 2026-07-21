import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import {
  ArtifactPublication,
  ArtifactRefConflictError,
  GitArtifactPublicationRepository,
  type ArtifactPublicationRepository,
  type BoundArtifactPublication,
} from "../../src/qrspi/artifact-publication"

const finalSha = "f".repeat(40)
const parentSha = "a".repeat(40)
const artifact = {
  repository: {
    providerInstanceId: "github",
    repositoryId: "42",
    repositoryFullName: "owner/repo",
  },
  workflowId: "workflow",
  generation: 1,
  stageKey: "questions",
  stageRevision: 1,
  commitSha: finalSha,
  path: "docs/qrspi/ticket/01-questions.md",
  blobSha: "b".repeat(40),
  contentSha256: "c".repeat(64),
  mediaType: "text/markdown",
} as const

function fixture(
  options: {
    readonly uncertainUpdate?: boolean
    readonly exactOldConflict?: boolean
    readonly staleAfterUpdate?: boolean
  } = {},
) {
  const calls: Array<unknown> = []
  let remoteSha = parentSha
  let currentChecks = 0
  let bound: BoundArtifactPublication | undefined
  const repository: ArtifactPublicationRepository = {
    finalizeDocument: (input) => {
      calls.push({ finalize: input })
      return Effect.succeed({ finalSha, parentSha, artifact })
    },
    updateRefExact: (input) => {
      calls.push({ update: input })
      if (options.exactOldConflict) {
        remoteSha = "9".repeat(40)
        return Effect.fail(
          new ArtifactRefConflictError({ expectedOld: parentSha, observed: remoteSha }),
        )
      }
      remoteSha = finalSha
      return options.uncertainUpdate
        ? Effect.fail(new Error("connection reset after update"))
        : Effect.void
    },
    observeRef: () => Effect.succeed(remoteSha),
    advanceLocalWorktree: () =>
      Effect.sync(() => {
        calls.push("advance-local")
      }),
  }
  return {
    calls,
    repository,
    current: () => {
      currentChecks += 1
      return Effect.succeed(!(options.staleAfterUpdate && currentChecks >= 3))
    },
    bind: (value: BoundArtifactPublication) => {
      calls.push("bind")
      if (bound !== undefined && bound.finalSha !== value.finalSha)
        return Effect.succeed("conflict" as const)
      bound = value
      return Effect.succeed("bound" as const)
    },
    complete: () => Effect.succeed("completed" as const),
    bound: () => bound,
  }
}

const input = {
  operationId: "artifact-publish:1",
  headRef: "feature/ticket",
  expectedOld: parentSha,
  candidateSha: "d".repeat(40),
  expectedPath: artifact.path,
  expectedContentSha256: artifact.contentSha256,
  artifactIdentity: {
    repository: artifact.repository,
    workflowId: artifact.workflowId,
    generation: artifact.generation,
    stageKey: artifact.stageKey,
    stageRevision: artifact.stageRevision,
    path: artifact.path,
    mediaType: artifact.mediaType,
  },
  trustedTrailers: [
    ["Provenance-Version", "1"],
    ["Ticket", "workflowd-vs3.4"],
    ["Workflowd-Job", "controller:artifact-publish:1"],
    ["Session", "session-ref"],
    ["Harness", "qrspi.document@1"],
    ["Agent", "qrspi-producer"],
    ["Model", "openai/gpt-5.6-sol"],
  ] as const,
}

describe("ArtifactPublication", () => {
  test("publishes one signed exact-parent commit with an exact-old fast-forward update", async () => {
    const fake = fixture()
    const result = await Effect.runPromise(
      ArtifactPublication.publish(input, {
        repository: fake.repository,
        isCurrent: fake.current,
        bind: fake.bind,
        complete: fake.complete,
      }),
    )

    expect(result).toEqual({ _tag: "Published", publication: { finalSha, parentSha, artifact } })
    expect(fake.calls.slice(0, 3)).toEqual([
      expect.objectContaining({ finalize: expect.anything() }),
      "bind",
      "advance-local",
    ])
    expect(fake.calls[3]).toEqual({
      update: {
        headRef: "feature/ticket",
        expectedOld: parentSha,
        newSha: finalSha,
        fastForwardOnly: true,
      },
    })
    expect(fake.bound()?.artifact.commitSha).toBe(finalSha)
  })

  test("durably binds the final document SHA before advancing local HEAD", async () => {
    const fake = fixture()
    const repository: ArtifactPublicationRepository = {
      ...fake.repository,
      advanceLocalWorktree: () => Effect.fail(new Error("process stopped after local advance")),
    }

    await expect(
      Effect.runPromise(
        ArtifactPublication.publish(input, {
          repository,
          isCurrent: fake.current,
          bind: fake.bind,
          complete: fake.complete,
        }),
      ),
    ).rejects.toThrow("process stopped")

    expect(fake.bound()?.finalSha).toBe(finalSha)
    expect(fake.calls.slice(0, 2)).toEqual([
      expect.objectContaining({ finalize: expect.anything() }),
      "bind",
    ])
  })

  test("recovers an uncertain update by authoritative observation without signing another SHA", async () => {
    const fake = fixture({ uncertainUpdate: true })

    const result = await Effect.runPromise(
      ArtifactPublication.publish(input, {
        repository: fake.repository,
        isCurrent: fake.current,
        bind: fake.bind,
        complete: fake.complete,
      }),
    )

    expect(result._tag).toBe("Published")
    expect(
      fake.calls.filter((call) => typeof call === "object" && call !== null && "finalize" in call),
    ).toHaveLength(1)
  })

  test("records a stale external effect but cannot advance the stale StageRun", async () => {
    const fake = fixture({ staleAfterUpdate: true })
    let completed = false

    const result = await Effect.runPromise(
      ArtifactPublication.publish(input, {
        repository: fake.repository,
        isCurrent: fake.current,
        bind: fake.bind,
        complete: () => {
          completed = true
          return Effect.succeed("completed" as const)
        },
      }),
    )

    expect(result).toEqual({ _tag: "StaleEffect", finalSha })
    expect(completed).toBe(false)
  })

  test("distinguishes an exact-old conflict from an uncertain update", async () => {
    const fake = fixture({ exactOldConflict: true })

    const result = await Effect.runPromise(
      ArtifactPublication.publish(input, {
        repository: fake.repository,
        isCurrent: fake.current,
        bind: fake.bind,
        complete: fake.complete,
      }),
    )

    expect(result).toEqual({ _tag: "Conflict", finalSha })
  })

  test("rejects a publisher result that violates exact parent or artifact identity", async () => {
    const fake = fixture()
    const repository: ArtifactPublicationRepository = {
      ...fake.repository,
      finalizeDocument: () => Effect.succeed({ finalSha, parentSha: "e".repeat(40), artifact }),
    }

    await expect(
      Effect.runPromise(
        ArtifactPublication.publish(input, {
          repository,
          isCurrent: fake.current,
          bind: fake.bind,
          complete: fake.complete,
        }),
      ),
    ).rejects.toThrow("exact parent")
    expect(fake.calls).toHaveLength(0)
  })
})

test("Git publisher verifies candidates, signs trusted commits, and updates only exact ticket refs", async () => {
  let remote = parentSha
  let commit = 0
  const commands: ReadonlyArray<string>[] = []
  const remoteEnvironments: NodeJS.ProcessEnv[] = []
  const trustedRemote = "https://github.com/owner/repo.git"
  const installationToken = "github-installation-token"
  const publisher = new GitArtifactPublicationRepository(
    "/repo",
    "1".repeat(40),
    trustedRemote,
    {
      run: (_operation, command, options) => {
        commands.push(command)
        expect(options?.env).toMatchObject({
          GIT_CONFIG: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        })
        const args = command.slice(1)
        if (args[0] === "update-ref" || (args[0] === "rev-parse" && args[1] === "HEAD")) {
          expect(options?.cwd).toBe("/repo")
          expect(options?.env?.GIT_DIR).toBeUndefined()
        } else {
          expect(options?.cwd).not.toBe("/repo")
          expect(options?.env?.GIT_DIR).not.toBeUndefined()
        }
        if (args[0] === "show" && args.includes("--format=%P")) return Effect.succeed(parentSha)
        if (args[0] === "show" && args.includes("--format=%T")) return Effect.succeed("tree-sha")
        if (args[0] === "show" && args.includes("--format=%T")) return Effect.succeed("tree-sha")
        if (args[0] === "diff-tree") return Effect.succeed(artifact.path)
        if (args[0] === "ls-tree") {
          const path = String(args.at(-1))
          return Effect.succeed(
            path === artifact.path
              ? `100644 blob ${artifact.blobSha}\t${path}`
              : `040000 tree ${"7".repeat(40)}\t${path}`,
          )
        }
        if (args[0] === "commit-tree") {
          commit += 1
          return Effect.succeed(commit === 1 ? finalSha : "9".repeat(40))
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") return Effect.succeed("d".repeat(40))
        if (args[0] === "rev-parse") return Effect.succeed(artifact.blobSha)
        if (args[0] === "verify-commit" || args[0] === "merge-base") return Effect.succeed("")
        if (args[0] === "ls-remote") {
          if (options?.env === undefined) return Effect.die("Missing Git environment")
          remoteEnvironments.push(options.env)
          return Effect.succeed(`${remote}\trefs/heads/feature/ticket`)
        }
        if (args[0] === "push") {
          if (options?.env === undefined) return Effect.die("Missing Git environment")
          remoteEnvironments.push(options.env)
          remote = String(args.at(-1)?.split(":")[0])
          return Effect.succeed("")
        }
        if (args[0] === "update-ref") return Effect.succeed("")
        return Effect.die(`Unexpected git command: ${args.join(" ")}`)
      },
      runBytes: (_operation, command, options) => {
        expect(options.cwd).not.toBe("/repo")
        expect(options.env?.GIT_DIR).not.toBeUndefined()
        return Effect.succeed({
          stdout: new TextEncoder().encode(
            command.includes("diff-tree") ? artifact.path : "# Questions",
          ),
          truncated: false,
        })
      },
    },
    () => Promise.resolve(installationToken),
  )
  const contentSha256 = createHash("sha256").update("# Questions").digest("hex")
  const identity = {
    repository: artifact.repository,
    workflowId: artifact.workflowId,
    generation: artifact.generation,
    stageKey: artifact.stageKey,
    stageRevision: artifact.stageRevision,
    path: artifact.path,
    mediaType: artifact.mediaType,
  }

  const document = await Effect.runPromise(
    publisher.finalizeDocument({
      operationId: "publish:1",
      candidateSha: "d".repeat(40),
      expectedParentSha: parentSha,
      expectedPath: artifact.path,
      expectedContentSha256: contentSha256,
      artifactIdentity: identity,
      trustedTrailers: input.trustedTrailers,
    }),
  )
  await Effect.runPromise(
    publisher.advanceLocalWorktree({
      candidateSha: "d".repeat(40),
      finalSha: document.finalSha,
    }),
  )
  const finalizeImplementation = publisher.finalizeImplementation
  if (finalizeImplementation === undefined) throw new Error("Expected implementation publisher")
  const implementation = await Effect.runPromise(
    finalizeImplementation({
      operationId: "publish:2",
      candidateSha: "8".repeat(40),
      expectedParentSha: parentSha,
      expectedChangedPaths: [artifact.path],
      trustedTrailers: input.trustedTrailers,
    }),
  )
  await Effect.runPromise(
    publisher.updateRefExact({
      headRef: "feature/ticket",
      expectedOld: parentSha,
      newSha: document.finalSha,
      fastForwardOnly: true,
    }),
  )

  expect(document).toMatchObject({
    finalSha,
    parentSha,
    artifact: { blobSha: artifact.blobSha, contentSha256 },
  })
  expect(implementation).toEqual({ finalSha: "9".repeat(40), parentSha })
  expect(await Effect.runPromise(publisher.observeRef("feature/ticket"))).toBe(finalSha)
  expect(commands.some((command) => command.includes(`-S${"1".repeat(40)}`))).toBe(true)
  expect(
    commands.some((command) =>
      command.includes(`--force-with-lease=refs/heads/feature/ticket:${parentSha}`),
    ),
  ).toBe(true)
  expect(commands.some((command) => command.includes("origin"))).toBe(false)
  expect(commands.filter((command) => command.includes("push")).flat()).toContain(trustedRemote)
  expect(commands.filter((command) => command.includes("ls-remote")).flat()).toContain(
    trustedRemote,
  )
  expect(commands.flat().join(" ")).not.toContain(installationToken)
  expect(remoteEnvironments).toHaveLength(3)
  for (const environment of remoteEnvironments) {
    expect(environment).toMatchObject({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${installationToken}`).toString("base64")}`,
    })
  }
  expect(
    commands.some((command) =>
      command.join(" ").includes(`update-ref HEAD ${finalSha} ${"d".repeat(40)}`),
    ),
  ).toBe(true)
  expect(commands.some((command) => command.includes("reset"))).toBe(false)
})

test("Git publisher ignores producer-controlled repository URL and GPG configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-artifact-producer-"))
  try {
    await mkdir(join(directory, ".git", "objects"), { recursive: true })
    await writeFile(
      join(directory, ".git", "config"),
      [
        "[core]",
        "\trepositoryformatversion = 0",
        '[url "https://attacker.invalid/"]',
        "\tinsteadOf = https://github.com/",
        "[gpg]",
        "\tprogram = /attacker-controlled-gpg",
      ].join("\n"),
    )
    const publisher = new GitArtifactPublicationRepository(
      directory,
      "1".repeat(40),
      "https://github.com/owner/repo.git",
      {
        run: (_operation, command, options) => {
          if (options?.cwd === undefined || options.env === undefined) {
            return Effect.die("Missing isolated Git execution options")
          }
          const configured = Bun.spawnSync(["git", "config", "--get-regexp", "^(url\\.|gpg\\.)"], {
            cwd: options.cwd,
            env: options.env,
            stdout: "pipe",
            stderr: "pipe",
          })
          expect(configured.exitCode).toBe(1)
          expect(configured.stdout.toString()).toBe("")
          expect(options.cwd).not.toBe(directory)
          expect(options.env.GIT_DIR).not.toBeUndefined()
          expect(command).toContain("https://github.com/owner/repo.git")
          return Effect.succeed("")
        },
        runBytes: () => Effect.die("Unexpected byte command"),
      },
    )

    expect(await Effect.runPromise(publisher.observeRef("feature/ticket"))).toBeNull()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("Git publisher reads valid multibyte document content within the output envelope", async () => {
  const content = "é".repeat(600_000)
  const encoded = new TextEncoder().encode(content)
  let requestedBytes = 0
  const publisher = new GitArtifactPublicationRepository(
    "/repo",
    "1".repeat(40),
    "https://github.com/owner/repo.git",
    {
      run: (_operation, command) => {
        const args = command.slice(1)
        if (args[0] === "show" && args.includes("--format=%P")) return Effect.succeed(parentSha)
        if (args[0] === "show" && args.includes("--format=%T")) return Effect.succeed("tree-sha")
        if (args[0] === "diff-tree") return Effect.succeed(artifact.path)
        if (args[0] === "ls-tree") {
          const path = String(args.at(-1))
          return Effect.succeed(
            path === artifact.path
              ? `100644 blob ${artifact.blobSha}\t${path}`
              : `040000 tree ${"7".repeat(40)}\t${path}`,
          )
        }
        if (args[0] === "commit-tree") return Effect.succeed(finalSha)
        if (args[0] === "verify-commit") return Effect.succeed("")
        if (args[0] === "rev-parse") return Effect.succeed(artifact.blobSha)
        return Effect.die(`Unexpected git command: ${args.join(" ")}`)
      },
      runBytes: (_operation, command, options) => {
        requestedBytes = options.maxStdoutBytes
        if (command.includes("diff-tree")) {
          return Effect.succeed({
            stdout: new TextEncoder().encode(artifact.path),
            truncated: false,
          })
        }
        return Effect.succeed({ stdout: encoded, truncated: encoded.byteLength >= requestedBytes })
      },
    },
  )

  await expect(
    Effect.runPromise(
      publisher.finalizeDocument({
        operationId: "publish:multibyte",
        candidateSha: "d".repeat(40),
        expectedParentSha: parentSha,
        expectedPath: artifact.path,
        expectedContentSha256: createHash("sha256").update(encoded).digest("hex"),
        artifactIdentity: {
          repository: artifact.repository,
          workflowId: artifact.workflowId,
          generation: artifact.generation,
          stageKey: artifact.stageKey,
          stageRevision: artifact.stageRevision,
          path: artifact.path,
          mediaType: artifact.mediaType,
        },
        trustedTrailers: input.trustedTrailers,
      }),
    ),
  ).resolves.toMatchObject({ finalSha })
  expect(requestedBytes).toBeGreaterThan(encoded.byteLength)
})

test.each(["document", "implementation"] as const)(
  "rejects a truncated %s path listing before signing",
  async (kind) => {
    let signed = false
    let requestedBytes = 0
    const publisher = new GitArtifactPublicationRepository(
      "/repo",
      "1".repeat(40),
      "https://github.com/owner/repo.git",
      {
        run: (_operation, command) => {
          const args = command.slice(1)
          if (args[0] === "show" && args.includes("--format=%P")) return Effect.succeed(parentSha)
          if (args[0] === "diff-tree") return Effect.die("path listing must use bounded output")
          if (args[0] === "commit-tree") {
            signed = true
            return Effect.succeed(finalSha)
          }
          return Effect.die(`Unexpected git command: ${args.join(" ")}`)
        },
        runBytes: (_operation, command, options) => {
          expect(command).toContain("diff-tree")
          requestedBytes = options.maxStdoutBytes
          return Effect.succeed({
            stdout: new Uint8Array(options.maxStdoutBytes),
            truncated: true,
          })
        },
      },
    )

    const result =
      kind === "document"
        ? publisher.finalizeDocument({
            operationId: "publish:oversized-document",
            candidateSha: "d".repeat(40),
            expectedParentSha: parentSha,
            expectedPath: artifact.path,
            expectedContentSha256: artifact.contentSha256,
            artifactIdentity: {
              repository: artifact.repository,
              workflowId: artifact.workflowId,
              generation: artifact.generation,
              stageKey: artifact.stageKey,
              stageRevision: artifact.stageRevision,
              path: artifact.path,
              mediaType: artifact.mediaType,
            },
            trustedTrailers: input.trustedTrailers,
          })
        : publisher.finalizeImplementation({
            operationId: "publish:oversized-implementation",
            candidateSha: "d".repeat(40),
            expectedParentSha: parentSha,
            expectedChangedPaths: [artifact.path],
            trustedTrailers: input.trustedTrailers,
          })

    await expect(Effect.runPromise(result)).rejects.toThrow("path listing exceeded bound")
    expect(requestedBytes).toBeGreaterThan(0)
    expect(signed).toBe(false)
  },
)

test.each([
  ["symlink artifact", artifact.path, "120000", "blob"],
  ["gitlink artifact", artifact.path, "160000", "commit"],
  ["executable artifact", artifact.path, "100755", "blob"],
  ["symlink ancestor", "docs/qrspi", "120000", "blob"],
  ["gitlink ancestor", "docs/qrspi", "160000", "commit"],
] as const)("rejects a %s before signing", async (_description, unsafePath, mode, type) => {
  let signed = false
  const publisher = new GitArtifactPublicationRepository(
    "/repo",
    "1".repeat(40),
    "https://github.com/owner/repo.git",
    {
      run: (_operation, command) => {
        const args = command.slice(1)
        if (args[0] === "show" && args.includes("--format=%P")) return Effect.succeed(parentSha)
        if (args[0] === "diff-tree") return Effect.succeed(artifact.path)
        if (args[0] === "ls-tree") {
          const path = String(args.at(-1))
          if (path === unsafePath)
            return Effect.succeed(`${mode} ${type} ${"7".repeat(40)}\t${path}`)
          return Effect.succeed(
            path === artifact.path
              ? `100644 blob ${artifact.blobSha}\t${path}`
              : `040000 tree ${"7".repeat(40)}\t${path}`,
          )
        }
        if (args[0] === "commit-tree") {
          signed = true
          return Effect.succeed(finalSha)
        }
        return Effect.die(`Unexpected git command: ${args.join(" ")}`)
      },
      runBytes: (_operation, command) =>
        Effect.succeed({
          stdout: new TextEncoder().encode(
            command.includes("diff-tree") ? artifact.path : "# Questions",
          ),
          truncated: false,
        }),
    },
  )

  await expect(
    Effect.runPromise(
      publisher.finalizeDocument({
        operationId: "publish:unsafe",
        candidateSha: "d".repeat(40),
        expectedParentSha: parentSha,
        expectedPath: artifact.path,
        expectedContentSha256: createHash("sha256").update("# Questions").digest("hex"),
        artifactIdentity: {
          repository: artifact.repository,
          workflowId: artifact.workflowId,
          generation: artifact.generation,
          stageKey: artifact.stageKey,
          stageRevision: artifact.stageRevision,
          path: artifact.path,
          mediaType: artifact.mediaType,
        },
        trustedTrailers: input.trustedTrailers,
      }),
    ),
  ).rejects.toThrow("unsafe Git tree mode")
  expect(signed).toBe(false)
})
