import { createHash } from "node:crypto"
import { Context, Data, Effect, Schema } from "effect"
import { MAX_AGENT_OUTPUT_BYTES } from "../agent-payload"
import { runWorkspaceCommand, runWorkspaceCommandBytes } from "../workspace/command"
import { ArtifactReference, type ArtifactReference as ArtifactReferenceValue } from "./stages"

const GitSha = Schema.String.pipe(Schema.pattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/))
const TrustedTrailerNames = [
  "Provenance-Version",
  "Ticket",
  "Workflowd-Job",
  "Session",
  "Harness",
  "Agent",
  "Model",
] as const

export type BoundArtifactPublication = {
  readonly finalSha: string
  readonly parentSha: string
  readonly artifact: ArtifactReferenceValue
}

export type ArtifactPublicationRepository = {
  readonly finalizeDocument: (input: {
    readonly operationId: string
    readonly candidateSha: string
    readonly expectedParentSha: string
    readonly expectedPath: string
    readonly expectedContentSha256: string
    readonly artifactIdentity: Omit<
      ArtifactReferenceValue,
      "commitSha" | "blobSha" | "contentSha256"
    >
    readonly trustedTrailers: ReadonlyArray<readonly [string, string]>
  }) => Effect.Effect<BoundArtifactPublication, Error>
  readonly updateRefExact: (input: {
    readonly headRef: string
    readonly expectedOld: string
    readonly newSha: string
    readonly fastForwardOnly: true
  }) => Effect.Effect<void, Error>
  readonly observeRef: (headRef: string) => Effect.Effect<string | null, Error>
  readonly advanceLocalWorktree: (input: {
    readonly candidateSha: string
    readonly finalSha: string
  }) => Effect.Effect<void, Error>
  readonly finalizeImplementation?: (input: {
    readonly operationId: string
    readonly candidateSha: string
    readonly expectedParentSha: string
    readonly expectedChangedPaths: ReadonlyArray<string>
    readonly trustedTrailers: ReadonlyArray<readonly [string, string]>
  }) => Effect.Effect<{ readonly finalSha: string; readonly parentSha: string }, Error>
}

export const ArtifactPublicationRepositoryService =
  Context.GenericTag<ArtifactPublicationRepository>("workflowd/qrspi/ArtifactPublicationRepository")

export type ArtifactPublicationRepositoryFactory = {
  readonly forDirectory: (directory: string) => ArtifactPublicationRepository
}

export const ArtifactPublicationRepositoryFactoryService =
  Context.GenericTag<ArtifactPublicationRepositoryFactory>(
    "workflowd/qrspi/ArtifactPublicationRepositoryFactory",
  )

export class ArtifactRefConflictError extends Data.TaggedError("ArtifactRefConflictError")<{
  readonly expectedOld: string
  readonly observed: string | null
}> {}

export class GitArtifactPublicationRepository implements ArtifactPublicationRepository {
  constructor(
    private readonly directory: string,
    private readonly signingKey: string,
    private readonly command: {
      readonly run: typeof runWorkspaceCommand
      readonly runBytes: typeof runWorkspaceCommandBytes
    } = { run: runWorkspaceCommand, runBytes: runWorkspaceCommandBytes },
  ) {}

  readonly finalizeDocument: ArtifactPublicationRepository["finalizeDocument"] = (input) =>
    Effect.gen(this, function* () {
      const parent = yield* this.git("read candidate parent", [
        "show",
        "-s",
        "--format=%P",
        input.candidateSha,
      ])
      if (parent !== input.expectedParentSha) {
        return yield* Effect.fail(new Error("Candidate commit does not have the exact parent"))
      }
      const changed = (yield* this.git("read candidate paths", [
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        input.candidateSha,
      ]))
        .split("\n")
        .filter(Boolean)
      if (changed.length !== 1 || changed[0] !== input.expectedPath) {
        return yield* Effect.fail(new Error("Candidate commit changes paths outside the artifact"))
      }
      const segments = input.expectedPath.split("/")
      for (let index = 1; index <= segments.length; index += 1) {
        const path = segments.slice(0, index).join("/")
        const entry = yield* this.git("verify artifact tree mode", [
          "ls-tree",
          input.candidateSha,
          "--",
          path,
        ])
        const match = /^(\d{6}) (\S+) [0-9a-f]+\t(.+)$/.exec(entry)
        const expectedMode = index === segments.length ? "100644" : "040000"
        const expectedType = index === segments.length ? "blob" : "tree"
        if (
          match === null ||
          match[1] !== expectedMode ||
          match[2] !== expectedType ||
          match[3] !== path
        ) {
          return yield* Effect.fail(new Error(`Artifact path has unsafe Git tree mode: ${path}`))
        }
      }
      const content = yield* this.gitBytes("read candidate artifact", [
        "show",
        `${input.candidateSha}:${input.expectedPath}`,
      ])
      if (createHash("sha256").update(content).digest("hex") !== input.expectedContentSha256) {
        return yield* Effect.fail(
          new Error("Candidate artifact content does not match prepared output"),
        )
      }
      const tree = yield* this.git("read candidate tree", [
        "show",
        "-s",
        "--format=%T",
        input.candidateSha,
      ])
      const message = [
        `Publish QRSPI ${input.artifactIdentity.stageKey}`,
        "",
        ...input.trustedTrailers.map(([name, value]) => `${name}: ${value}`),
      ].join("\n")
      const finalSha = yield* this.git("sign artifact commit", [
        "commit-tree",
        tree,
        "-p",
        input.expectedParentSha,
        `-S${this.signingKey}`,
        "-m",
        message,
      ])
      yield* this.git("verify artifact signature", ["verify-commit", finalSha])
      const blobSha = yield* this.git("read artifact blob", [
        "rev-parse",
        `${finalSha}:${input.expectedPath}`,
      ])
      return {
        finalSha,
        parentSha: input.expectedParentSha,
        artifact: {
          ...input.artifactIdentity,
          commitSha: finalSha,
          blobSha,
          contentSha256: input.expectedContentSha256,
        },
      }
    })

  readonly updateRefExact: ArtifactPublicationRepository["updateRefExact"] = (input) =>
    Effect.gen(this, function* () {
      const observed = yield* this.observeRef(input.headRef)
      if (observed !== input.expectedOld) {
        return yield* Effect.fail(
          new ArtifactRefConflictError({ expectedOld: input.expectedOld, observed }),
        )
      }
      yield* this.git("verify artifact fast-forward", [
        "merge-base",
        "--is-ancestor",
        input.expectedOld,
        input.newSha,
      ])
      yield* this.git("update exact ticket ref", [
        "push",
        `--force-with-lease=refs/heads/${input.headRef}:${input.expectedOld}`,
        "origin",
        `${input.newSha}:refs/heads/${input.headRef}`,
      ])
    })

  readonly observeRef: ArtifactPublicationRepository["observeRef"] = (headRef) =>
    this.git("observe ticket ref", [
      "ls-remote",
      "--heads",
      "origin",
      `refs/heads/${headRef}`,
    ]).pipe(Effect.map((output) => output.split(/\s+/)[0] || null))

  readonly advanceLocalWorktree: ArtifactPublicationRepository["advanceLocalWorktree"] = (input) =>
    Effect.gen(this, function* () {
      const head = yield* this.git("read local worktree head", ["rev-parse", "HEAD"])
      if (head === input.finalSha) return
      if (head !== input.candidateSha) {
        return yield* Effect.fail(
          new Error("Local worktree HEAD is neither the candidate nor signed final SHA"),
        )
      }
      yield* this.git("advance local worktree branch", [
        "update-ref",
        "HEAD",
        input.finalSha,
        input.candidateSha,
      ])
    })

  readonly finalizeImplementation = (input: {
    readonly operationId: string
    readonly candidateSha: string
    readonly expectedParentSha: string
    readonly expectedChangedPaths: ReadonlyArray<string>
    readonly trustedTrailers: ReadonlyArray<readonly [string, string]>
  }) =>
    Effect.gen(this, function* () {
      const parent = yield* this.git("read implementation parent", [
        "show",
        "-s",
        "--format=%P",
        input.candidateSha,
      ])
      if (parent !== input.expectedParentSha) {
        return yield* Effect.fail(new Error("Implementation commit does not have the exact parent"))
      }
      const changed = (yield* this.git("read implementation paths", [
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        input.candidateSha,
      ]))
        .split("\n")
        .filter(Boolean)
        .sort()
      if (JSON.stringify(changed) !== JSON.stringify([...input.expectedChangedPaths].sort())) {
        return yield* Effect.fail(new Error("Implementation paths do not match prepared output"))
      }
      const tree = yield* this.git("read implementation tree", [
        "show",
        "-s",
        "--format=%T",
        input.candidateSha,
      ])
      const message = [
        "Publish QRSPI implementation checkpoint",
        "",
        ...input.trustedTrailers.map(([name, value]) => `${name}: ${value}`),
      ].join("\n")
      const finalSha = yield* this.git("sign implementation commit", [
        "commit-tree",
        tree,
        "-p",
        input.expectedParentSha,
        `-S${this.signingKey}`,
        "-m",
        message,
      ])
      yield* this.git("verify implementation signature", ["verify-commit", finalSha])
      return { finalSha, parentSha: input.expectedParentSha }
    })

  private git(operation: string, args: ReadonlyArray<string>) {
    return this.command
      .run(operation, ["git", ...args], { cwd: this.directory })
      .pipe(Effect.mapError((cause) => new Error(`${operation}: ${String(cause)}`, { cause })))
  }

  private gitBytes(operation: string, args: ReadonlyArray<string>) {
    return this.command
      .runBytes(operation, ["git", ...args], {
        cwd: this.directory,
        maxStdoutBytes: MAX_AGENT_OUTPUT_BYTES + 1,
      })
      .pipe(
        Effect.flatMap((result) =>
          result.truncated
            ? Effect.fail(new Error(`${operation}: output exceeded artifact bound`))
            : Effect.succeed(result.stdout),
        ),
        Effect.mapError((cause) =>
          cause instanceof Error ? cause : new Error(`${operation}: ${String(cause)}`, { cause }),
        ),
      )
  }
}

type PublicationInput = {
  readonly operationId: string
  readonly headRef: string
  readonly expectedOld: string
  readonly candidateSha: string
  readonly expectedPath: string
  readonly expectedContentSha256: string
  readonly artifactIdentity: Omit<ArtifactReferenceValue, "commitSha" | "blobSha" | "contentSha256">
  readonly trustedTrailers: ReadonlyArray<readonly [string, string]>
  readonly bound?: BoundArtifactPublication
}

type PublicationDependencies = {
  readonly repository: ArtifactPublicationRepository
  readonly isCurrent: () => Effect.Effect<boolean, Error>
  readonly bind: (
    publication: BoundArtifactPublication,
  ) => Effect.Effect<"bound" | "conflict" | "stale", Error>
  readonly complete: (
    publication: BoundArtifactPublication,
  ) => Effect.Effect<"completed" | "stale", Error>
}

const assertCurrent = (dependencies: PublicationDependencies) =>
  dependencies
    .isCurrent()
    .pipe(
      Effect.flatMap((current) =>
        current ? Effect.void : Effect.fail(new Error("Artifact publication is stale")),
      ),
    )

export const ArtifactPublication = {
  publish: (input: PublicationInput, dependencies: PublicationDependencies) =>
    Effect.gen(function* () {
      yield* Schema.decodeUnknown(GitSha)(input.expectedOld)
      yield* Schema.decodeUnknown(GitSha)(input.candidateSha)
      assertTrustedTrailers(input.trustedTrailers)
      yield* assertCurrent(dependencies)

      const publication =
        input.bound ??
        (yield* dependencies.repository.finalizeDocument({
          operationId: input.operationId,
          candidateSha: input.candidateSha,
          expectedParentSha: input.expectedOld,
          expectedPath: input.expectedPath,
          expectedContentSha256: input.expectedContentSha256,
          artifactIdentity: input.artifactIdentity,
          trustedTrailers: input.trustedTrailers,
        }))
      validatePublication(input, publication)

      if (input.bound === undefined) {
        const binding = yield* dependencies.bind(publication)
        if (binding === "conflict") {
          return yield* Effect.fail(
            new Error("ArtifactPublish operation is already bound to another final SHA"),
          )
        }
        if (binding === "stale") return { _tag: "StaleBeforeEffect" as const }
      }
      yield* dependencies.repository.advanceLocalWorktree({
        candidateSha: input.candidateSha,
        finalSha: publication.finalSha,
      })

      const currentBeforeUpdate = yield* dependencies.isCurrent()
      if (!currentBeforeUpdate) return { _tag: "StaleBeforeEffect" as const }
      const update = yield* dependencies.repository
        .updateRefExact({
          headRef: input.headRef,
          expectedOld: input.expectedOld,
          newSha: publication.finalSha,
          fastForwardOnly: true,
        })
        .pipe(
          Effect.as("updated" as const),
          Effect.catchAll((error) =>
            Effect.succeed(error instanceof ArtifactRefConflictError ? "conflict" : "uncertain"),
          ),
        )

      const observed = yield* dependencies.repository.observeRef(input.headRef)
      if (observed !== publication.finalSha) {
        if (update === "conflict") {
          return { _tag: "Conflict" as const, finalSha: publication.finalSha }
        }
        if (observed !== null && observed !== input.expectedOld) {
          return { _tag: "Conflict" as const, finalSha: publication.finalSha, observed }
        }
        return { _tag: "WaitingExternal" as const, finalSha: publication.finalSha, observed }
      }
      const currentAfterEffect = yield* dependencies.isCurrent()
      if (!currentAfterEffect) {
        return { _tag: "StaleEffect" as const, finalSha: publication.finalSha }
      }
      const completion = yield* dependencies.complete(publication)
      if (completion === "stale") {
        return { _tag: "StaleEffect" as const, finalSha: publication.finalSha }
      }
      return { _tag: "Published" as const, publication }
    }),
}

function validatePublication(input: PublicationInput, publication: BoundArtifactPublication): void {
  Schema.decodeUnknownSync(GitSha)(publication.finalSha)
  Schema.decodeUnknownSync(ArtifactReference)(publication.artifact)
  if (publication.parentSha !== input.expectedOld) {
    throw new Error("Final publication commit does not have the exact parent")
  }
  if (publication.artifact.commitSha !== publication.finalSha) {
    throw new Error("Artifact commit identity does not match the final signed SHA")
  }
  if (
    publication.artifact.path !== input.expectedPath ||
    publication.artifact.contentSha256 !== input.expectedContentSha256
  ) {
    throw new Error("Artifact identity does not match prepared output")
  }
}

function assertTrustedTrailers(trailers: ReadonlyArray<readonly [string, string]>): void {
  if (
    trailers.length !== TrustedTrailerNames.length ||
    trailers.some(
      ([name, value], index) => name !== TrustedTrailerNames[index] || value.length === 0,
    )
  ) {
    throw new Error("Trusted publication trailers are missing, reordered, or empty")
  }
}
