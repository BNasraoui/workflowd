import { describe, expect, test } from "bun:test"
import { Cause, Effect, Layer } from "effect"
import { loadConfig } from "../src/config"
import {
  DOGFOOD_ENRICHMENT_CONTRACT,
  DogfoodStore,
  type DogfoodEnrichmentDocument,
} from "../src/kernel/dogfood-store"
import { startHookService } from "../src/runtime"
import { agentGitTestEnvironment } from "./helpers/agent-git-config"

import { kernelLayer, stubAdapters } from "./helpers/runtime"
describe("dogfood enrichment wiring", () => {
  const dogfoodDocument: DogfoodEnrichmentDocument = {
    contract: DOGFOOD_ENRICHMENT_CONTRACT,
    sessions: {
      ses_idle: { harness: "opencode", harness_version: 1, machine: "mint" },
    },
  }

  /** Shared across both wiring tests so the stub block exists exactly once. */
  const loadDogfoodConfig = () =>
    loadConfig(
      {
        ...agentGitTestEnvironment,
        GITHUB_APP_ID: "123",
        WORKFLOWD_PR_REPOSITORIES: '[{"repository":"example-owner/example","installationId":91}]',
        WORKFLOWD_ALLOWED_INSTALLATION_ACCOUNT_IDS: "81005232,319835875",
        GITHUB_PRIVATE_KEY_PATH: "/tmp/key",
        GITHUB_WEBHOOK_SECRET: "secret",
        OPENCODE_SERVER_PASSWORD: "password",
        WORKFLOWD_REVIEW_OPENCODE_PASSWORD: "review-password",
        WORKFLOWD_OPENCODE_ATTACH_URL: "https://mint.example-tailnet.ts.net:4096",
        WORKFLOWD_DOGFOOD_TOKEN: "dogfood-secret",
      },
      { home: "/tmp" },
    )

  test("serves the configured route from the wired dogfood store", async () => {
    const loaded = await loadDogfoodConfig()
    const config = {
      ...loaded,
      http: { ...loaded.http, port: 0 },
      worker: { ...loaded.worker, concurrency: 0, pollIntervalMs: 60_000 },
    }
    const adapters = Layer.merge(
      stubAdapters(),
      Layer.succeed(DogfoodStore, { sessions: () => Effect.succeed(dogfoodDocument) }),
    )

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* startHookService(config)
          const base = `http://${server.hostname}:${server.port}/workflows/dogfood/sessions`
          const authorized = yield* Effect.tryPromise(() =>
            fetch(base, { headers: { authorization: "Bearer dogfood-secret" } }),
          )
          const unauthorized = yield* Effect.tryPromise(() => fetch(base))
          return {
            authorized: {
              status: authorized.status,
              body: yield* Effect.promise(() => authorized.json()),
            },
            unauthorized: unauthorized.status,
          }
        }),
      ).pipe(Effect.provide(Layer.merge(kernelLayer(":memory:"), adapters))),
    )

    expect(result.authorized).toEqual({ status: 200, body: dogfoodDocument })
    expect(result.unauthorized).toBe(401)
  })

  test("refuses to start when dogfood is configured without its store", async () => {
    const loaded = await loadDogfoodConfig()
    const config = { ...loaded, worker: { ...loaded.worker, concurrency: 0 } }

    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(startHookService(config)).pipe(
          Effect.provide(Layer.merge(kernelLayer(":memory:"), stubAdapters())),
        ),
      ),
    )

    expect(exit._tag).toBe("Failure")
    expect(Cause.pretty(exit._tag === "Failure" ? exit.cause : Cause.empty)).toContain(
      "Dogfood enrichment is configured without its store",
    )
  })
})
