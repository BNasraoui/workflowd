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

async function observeModel(model: Model.Info) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
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
    return await makeExecutionCapabilities({
      host: "box",
      refreshMs: 1000,
      timeoutMs: 1000,
      sources: [makeOpenCodeDiscovery("oc", client)],
    }).list()
  } finally {
    await server.stop(true)
  }
}

test("OpenCode preserves raw body effort strings for defaults and variants without provider overlays", async () => {
  const result = await observeModel({
    ...Model.Info.default(Model.Ref.fields.providerID.make("fixture"), Model.ID.make("fixture")),
    settings: { reasoningEffort: "settings-effort", apiKey: "private-credential" },
    body: { reasoning_effort: "provider-deliberate", api_key: "private-credential" },
    variants: [
      {
        id: Model.VariantID.make("deep"),
        body: { reasoning_effort: "provider-extreme", secret: "private-credential" },
      },
    ],
  })
  expect(result.capabilities[0]?.thinking.defaultEffort).toBe("provider-deliberate")
  expect(result.capabilities[0]?.thinking.variants).toEqual([
    { id: "deep", effort: "provider-extreme" },
  ])
  expect(JSON.stringify(result)).not.toContain("private-credential")
})

test("OpenCode merges distinct native budget parameters and lets body override matching settings", async () => {
  const settings = { reasoningBudget: 1024, thinkingBudget: 512, apiKey: "private-credential" }
  const body = {
    thinkingBudget: 4096,
    thinking: { budget_tokens: 2048 },
    secret: "private-credential",
  }
  const result = await observeModel({
    ...Model.Info.default(Model.Ref.fields.providerID.make("fixture"), Model.ID.make("fixture")),
    settings,
    body,
    variants: [{ id: Model.VariantID.make("deep"), settings, body }],
  })
  const budgets = [
    { parameter: "reasoningBudget", value: 1024, unit: "tokens" },
    { parameter: "thinkingBudget", value: 4096, unit: "tokens" },
    { parameter: "thinking.budget_tokens", value: 2048, unit: "tokens" },
  ]
  expect(result.capabilities[0]?.thinking.defaultBudgets).toEqual(budgets)
  expect(result.capabilities[0]?.thinking.variants).toEqual([{ id: "deep", budgets }])
  expect(JSON.stringify(result)).not.toContain("private-credential")
})

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
    const { list } = makeExecutionCapabilities({
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
    const { list } = makeExecutionCapabilities({
      host: "box",
      sources: [source],
      refreshMs: 1,
      timeoutMs: 1000,
      now: () => 0,
    })
    expect((await list()).capabilities[0]?.availability).toBe("unavailable")
  } finally {
    await server.stop(true)
  }
})
