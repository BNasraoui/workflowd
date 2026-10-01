import { expect, test } from "bun:test"
import { Model, OpenCode } from "@opencode-ai/client/effect"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { makeExecutionCapabilities } from "../../src/execution-capabilities"
import { makeOpenCodeDiscovery } from "../../src/execution/opencode"
import { makeOpenCodeSdkClient } from "../../src/opencode/adapter"
import type { OpenCodeModelAvailability } from "../../src/opencode/adapter"

const location = {
  directory: "/fixture",
  project: { id: "fixture", directory: "/fixture", canonical: "/fixture" },
}

test("installed OpenCode SDK retains capabilities, variants, native ids and safe thinking defaults", async () => {
  const model = {
    ...Model.Info.default(Model.Ref.fields.providerID.make("fixture"), Model.ID.make("picker-id")),
    modelID: "native-id",
    capabilities: {
      tools: false,
      input: ["text"],
      output: ["text", "audio"],
      responsesWebsockets: true,
    },
    variants: [
      {
        id: "deliberate",
        settings: { reasoningEffort: "max", thinking: { budgetTokens: 24576 }, apiKey: "secret" },
        headers: { Authorization: "secret" },
      },
    ],
    settings: { reasoningEffort: "medium", thinkingBudget: 4096, apiKey: "secret" },
    headers: { Authorization: "secret" },
  }
  let advertised = [model]
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path.endsWith("/model/default")) return Response.json({ location, data: model })
      if (path.endsWith("/model")) return Response.json({ location, data: advertised })
      if (path.endsWith("/provider"))
        return Response.json({
          location,
          data: [
            {
              id: "fixture",
              name: "Fixture",
              activation: "enabled",
              package: "fixture",
              headers: { Authorization: "secret" },
            },
          ],
        })
      return new Response(null, { status: 404 })
    },
  })
  try {
    const client = OpenCode.make({ baseUrl: server.url.toString() }).pipe(
      Effect.provide(FetchHttpClient.layer),
    )
    const sdkModels: ReadonlyArray<OpenCodeModelAvailability> = await Effect.runPromise(
      makeOpenCodeSdkClient(client).listModels({}),
    )
    expect(sdkModels[0]).toMatchObject({
      nativeModelID: "native-id",
      capabilities: model.capabilities,
      variants: [
        {
          id: "deliberate",
          effort: "max",
          budgets: [{ parameter: "thinking.budgetTokens", value: 24576, unit: "tokens" }],
        },
      ],
    })
    let now = 0
    const list = makeExecutionCapabilities({
      host: "box",
      sources: [makeOpenCodeDiscovery("oc-local", client)],
      refreshMs: 1,
      timeoutMs: 1000,
      now: () => now,
    })
    const result = await list()
    expect(result.capabilities[0]).toMatchObject({
      identity: { host: "box", executor: "oc-local", provider: "fixture", model: "native-id" },
      selectionModel: "picker-id",
      tools: false,
      responsesWebsockets: true,
      limits: { context: 200000, output: 32000 },
      availability: "available",
      defaultModel: true,
      thinking: {
        defaultEffort: "medium",
        defaultBudgets: [{ parameter: "thinkingBudget", value: 4096, unit: "tokens" }],
      },
    })
    expect(JSON.stringify(result)).not.toContain("secret")
    advertised = [
      ...advertised,
      { ...model, id: Model.ID.make("new-picker"), modelID: "new-native" },
    ]
    now = 2
    expect((await list()).capabilities.map((entry) => entry.identity.model)).toEqual([
      "native-id",
      "new-native",
    ])
  } finally {
    await server.stop(true)
  }
})

test("OpenCode auth rejection and an unconfigured provider have honest availability", async () => {
  let unauthorized = true
  const model = Model.Info.default(
    Model.Ref.fields.providerID.make("no-auth"),
    Model.ID.make("catalog-only"),
  )
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (unauthorized) return new Response(null, { status: 401 })
      const path = new URL(request.url).pathname
      return Response.json({
        location,
        data: path.endsWith("/provider") ? [] : path.endsWith("/default") ? model : [model],
      })
    },
  })
  try {
    const client = OpenCode.make({ baseUrl: server.url.toString() }).pipe(
      Effect.provide(FetchHttpClient.layer),
    )
    const source = makeOpenCodeDiscovery("oc", client)
    expect(await source.discover(new AbortController().signal)).toEqual({
      status: "unauthenticated",
    })
    unauthorized = false
    const list = makeExecutionCapabilities({
      host: "box",
      sources: [source],
      refreshMs: 1,
      timeoutMs: 1000,
    })
    expect((await list()).capabilities[0]?.availability).toBe("unavailable")
  } finally {
    await server.stop(true)
  }
})
