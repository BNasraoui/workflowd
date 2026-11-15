import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { makeAgentRunCustody } from "../../src/kernel/agent-run-custody"
import { AgentRunRefusalError } from "../../src/kernel/agent-run-ingress"
import { KernelSessionStore } from "../../src/kernel/session-store"
import { runSessionKernel } from "./session-store-harness"

test("Actions session custody refuses a changed endpoint, resource or native session", async () => {
  await runSessionKernel(
    ":memory:",
    Effect.gen(function* () {
      const sessions = yield* KernelSessionStore
      const sql = yield* SqlClient.SqlClient
      const custody = makeAgentRunCustody({
        sessions,
        provider: undefined,
        waits: undefined,
        claude: undefined,
        options: {
          identity: {
            owningHostId: "mint",
            providerId: "opencode-primary",
            serverId: "opencode-primary",
            endpointAlias: "local",
            endpointIdentity: "http://127.0.0.1:4096",
            providerVersion: 1,
          },
          claudeHosts: [],
        },
        refuse: (reason, detail) => new AgentRunRefusalError({ reason, detail }),
      })
      const createdAt = new Date()
      const resourceId = yield* custody.ensureResource({
        resourceId: "native-resource",
        absolutePath: "/fixture/native",
        kind: "worktree",
        createdAt,
      })
      const input = {
        nativeSessionId: "ses_native",
        resourceId,
        createdAt,
        kind: "opencode" as const,
        actionsHost: "github-actions:78:1",
      }
      const id = yield* custody.ensureSession(input)
      expect(yield* sessions.readSession(id)).toMatchObject({
        server_id: "github-actions:78:1",
        endpoint_identity: "opencode-cli://github-actions:78:1",
      })
      expect(yield* custody.ensureSession(input)).toBe(id)
      for (const change of [{ actionsHost: "github-actions:78:2" }, { resourceId: "foreign" }]) {
        expect(
          (yield* custody.ensureSession({ ...input, ...change }).pipe(Effect.result))._tag,
        ).toBe("Failure")
      }
      yield* sql`UPDATE kernel_sessions SET native_session_id='ses_foreign' WHERE session_id=${id}`
      expect((yield* custody.ensureSession(input).pipe(Effect.result))._tag).toBe("Failure")
      expect((yield* sessions.readSession(id))?.native_session_id).toBe("ses_foreign")
      yield* sql`UPDATE kernel_sessions SET native_session_id='ses_native' WHERE session_id=${id}`
      expect(yield* custody.ensureSession(input)).toBe(id)
    }),
  )
})
