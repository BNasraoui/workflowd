import { expect, test } from "bun:test"
import { Model } from "@opencode-ai/client/effect"
import { Effect, Schema } from "effect"
import { ExecutionDiscovery } from "../../src/execution-capabilities"
import { loadDirectoryRunnerConfig } from "../../src/directory/config"
import { RunnerDiscoveryLive } from "../../src/directory/runner-discovery"

test("runner uses installed authenticated OpenCode discovery and projects native catalog/thinking metadata", async () => {
  const model = {
    ...Model.Info.default(
      Model.Ref.fields.providerID.make("fixture"),
      Model.ID.make("picker-model"),
    ),
    modelID: "native-model",
    settings: { reasoningEffort: "xhigh", apiKey: "private-overlay" },
    headers: { Authorization: "private-overlay" },
  }
  const location = {
    directory: "/fixture",
    project: { id: "fixture", directory: "/fixture", canonical: "/fixture" },
  }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      if (
        request.headers.get("authorization") !==
        `Basic ${Buffer.from("opencode:fixture-password").toString("base64")}`
      )
        return new Response(null, { status: 401 })
      const path = new URL(request.url).pathname
      return Response.json({
        location,
        data: path.endsWith("/provider")
          ? [
              {
                id: "fixture",
                name: "Fixture",
                activation: "enabled",
                package: "fixture",
                headers: { Authorization: "private-overlay" },
              },
            ]
          : path.endsWith("/default")
            ? model
            : [model],
      })
    },
  })
  try {
    const config = await loadDirectoryRunnerConfig(
      {
        WORKFLOWD_DIRECTORY_COORDINATOR_HOST: "host-a",
        WORKFLOWD_DIRECTORY_CREDENTIAL_FILE: "/fixture/key",
        WORKFLOWD_EXECUTION_CAPABILITIES_CODEX_ENABLED: "false",
        OPENCODE_SERVER_URL: server.url.toString(),
        OPENCODE_SERVER_PASSWORD_FILE: "/fixture/password",
      },
      async (path) =>
        path.endsWith("password") ? "fixture-password" : "isolated-credential-".repeat(3),
    )
    expect(config).toBeDefined()
    const catalog = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* ExecutionDiscovery).list()
      }).pipe(Effect.provide(RunnerDiscoveryLive("host-b", config!, false))),
    )
    expect(catalog.capabilities).toHaveLength(1)
    expect(catalog.capabilities[0]).toMatchObject({
      identity: { host: "host-b", executor: "opencode:opencode-primary", model: "native-model" },
      selectionModel: "picker-model",
      availability: "available",
      thinking: { defaultEffort: "xhigh" },
    })
    expect(JSON.stringify(catalog)).not.toContain("fixture-password")
    expect(JSON.stringify(catalog)).not.toContain("private-overlay")
    expect(Schema.is(Model.Info)(model)).toBe(true)
  } finally {
    await server.stop(true)
  }
})
