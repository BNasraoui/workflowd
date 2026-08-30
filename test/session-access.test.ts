import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import type { SessionReference } from "../src/agent-harness"
import {
  OpenCodeAdapterError,
  type OpenCodeAdapter,
  type OpenCodeSessionStatus,
} from "../src/opencode/adapter"
import { SessionAccessResolver } from "../src/session-access"

const reference: SessionReference = {
  sessionReferenceId: "session-reference-1",
  serverId: "opencode-primary",
  endpointAlias: "private-opencode",
  directory: "/worktrees/issue with 'quotes'",
  nativeSessionId: "ses_exact",
  scope: { _tag: "GenerationScope", workflowId: "workflow-1", generation: 3 },
  operationId: "operation-1",
  operationRevision: 2,
  attempt: 1,
  leaseToken: "lease-token-123456",
  createdAt: "2026-07-21T12:00:00.000Z",
  state: "created",
}

function adapter(
  status: OpenCodeSessionStatus | undefined,
  sessionExists = status !== undefined,
): OpenCodeAdapter {
  return {
    createSession: () => Effect.succeed({ id: "unused" }),
    promptSession: () => Effect.void,
    subscribeSessionEvents: () => Stream.empty,
    getSessionStatus: () => Effect.succeed(status),
    sessionExists: () => Effect.succeed(sessionExists),
    listSessionMessages: () => Effect.succeed([]),
    abortSession: () => Effect.succeed(true),
    validateAvailability: () => Effect.void,
    generateStructured: () => Effect.succeed(null),
  }
}

describe("SessionAccessResolver", () => {
  test("renders the exact resumable OpenCode command without credentials", async () => {
    const resolver = new SessionAccessResolver(
      adapter({ type: "idle" }),
      {
        serverId: "opencode-primary",
        endpointAlias: "private-opencode",
        attachUrl: "https://mint.tailnet.example:4096",
      },
      async () => true,
    )

    const access = await Effect.runPromise(resolver.resolve(reference))

    expect(access).toEqual({
      _tag: "Available",
      sessionReferenceId: "session-reference-1",
      command:
        "opencode attach 'https://mint.tailnet.example:4096' --dir '/worktrees/issue with '\"'\"'quotes'\"'\"'' --session 'ses_exact'",
    })
    if (access._tag !== "Available") throw new Error("expected available session")
    expect(access.command).not.toContain("password")
    expect(access.command).not.toContain("--continue")
  })

  test("represents a missing native session without redirecting", async () => {
    const resolver = new SessionAccessResolver(
      adapter(undefined, false),
      {
        serverId: "opencode-primary",
        endpointAlias: "private-opencode",
        attachUrl: "https://mint.tailnet.example:4096",
      },
      async () => true,
    )

    await expect(Effect.runPromise(resolver.resolve(reference))).resolves.toEqual({
      _tag: "Unavailable",
      sessionReferenceId: "session-reference-1",
      reason: "missing",
    })
  })

  test("rejects a reference for a different configured server generation", async () => {
    let probed = false
    const openCode = adapter({ type: "idle" })
    const resolver = new SessionAccessResolver(
      {
        ...openCode,
        getSessionStatus: (...args) =>
          Effect.suspend(() => {
            probed = true
            return openCode.getSessionStatus(...args)
          }),
      },
      {
        serverId: "replacement-server",
        endpointAlias: "private-opencode",
        attachUrl: "https://mint.tailnet.example:4096",
      },
      async () => true,
    )

    await expect(Effect.runPromise(resolver.resolve(reference))).resolves.toEqual({
      _tag: "Unavailable",
      sessionReferenceId: "session-reference-1",
      reason: "endpoint_mismatch",
    })
    expect(probed).toBe(false)
  })

  test.each(["failed", "superseded", "aborted", "expired"] as const)(
    "renders terminal %s references explicitly without probing",
    async (state) => {
      let probed = false
      const openCode = adapter({ type: "idle" })
      const resolver = new SessionAccessResolver(
        {
          ...openCode,
          getSessionStatus: (...args) =>
            Effect.suspend(() => {
              probed = true
              return openCode.getSessionStatus(...args)
            }),
        },
        {
          serverId: "opencode-primary",
          endpointAlias: "private-opencode",
          attachUrl: "https://mint.tailnet.example:4096",
        },
        async () => true,
      )

      await expect(Effect.runPromise(resolver.resolve({ ...reference, state }))).resolves.toEqual({
        _tag: "Unavailable",
        sessionReferenceId: "session-reference-1",
        reason: state,
      })
      expect(probed).toBe(false)
    },
  )

  test("keeps idle sessions available when the status map omits them", async () => {
    const resolver = new SessionAccessResolver(
      adapter(undefined, true),
      {
        serverId: "opencode-primary",
        endpointAlias: "private-opencode",
        attachUrl: "https://mint.tailnet.example:4096",
      },
      async () => true,
    )

    await expect(Effect.runPromise(resolver.resolve(reference))).resolves.toMatchObject({
      _tag: "Available",
      sessionReferenceId: "session-reference-1",
    })
  })

  test("reports an inaccessible server without suppressing the result publication", async () => {
    const resolver = new SessionAccessResolver(
      {
        ...adapter(undefined),
        sessionExists: () =>
          Effect.fail(
            new OpenCodeAdapterError({
              operation: "session exists",
              cause: new Error("server offline"),
            }),
          ),
      },
      {
        serverId: "opencode-primary",
        endpointAlias: "private-opencode",
        attachUrl: "https://mint.tailnet.example:4096",
      },
      async () => true,
    )

    await expect(Effect.runPromise(resolver.resolve(reference))).resolves.toEqual({
      _tag: "Unavailable",
      sessionReferenceId: "session-reference-1",
      reason: "unreachable",
    })
  })

  test("reports a cleaned worktree without probing or redirecting", async () => {
    let probed = false
    const openCode = adapter({ type: "idle" })
    const resolver = new SessionAccessResolver(
      {
        ...openCode,
        sessionExists: (...args) =>
          Effect.suspend(() => {
            probed = true
            return openCode.sessionExists(...args)
          }),
      },
      {
        serverId: "opencode-primary",
        endpointAlias: "private-opencode",
        attachUrl: "https://mint.tailnet.example:4096",
      },
      async () => false,
    )

    await expect(Effect.runPromise(resolver.resolve(reference))).resolves.toEqual({
      _tag: "Unavailable",
      sessionReferenceId: "session-reference-1",
      reason: "directory_missing",
    })
    expect(probed).toBe(false)
  })
})
