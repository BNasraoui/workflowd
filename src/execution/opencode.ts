import type { OpenCodeClient } from "@opencode-ai/client/effect"
import { Effect, Schema } from "effect"
import { HttpClientError } from "effect/unstable/http"
import type { DiscoverySource, ExecutionModel } from "../execution-capabilities"
import { publicOpenCodeModel } from "../opencode/model-capabilities"

export function makeOpenCodeDiscovery(
  executor: string,
  clientEffect: Effect.Effect<OpenCodeClient, Error>,
): DiscoverySource {
  return {
    executor,
    kind: "opencode",
    protocol: "opencode/model.list",
    discover: (signal) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* clientEffect
          const [models, providers, selected] = yield* Effect.all(
            [
              client.model.list(),
              client.provider.list(),
              client.model.default().pipe(Effect.catch(() => Effect.succeed(undefined))),
            ],
            { concurrency: "unbounded" },
          )
          const configured = new Set(
            providers.data
              .filter((provider) => provider.activation !== "disabled")
              .map((provider) => String(provider.id)),
          )
          return models.data.map((native): ExecutionModel => {
            const model = publicOpenCodeModel(native)
            return {
              provider: model.providerID,
              model: native.modelID,
              selectionModel: model.id,
              name: native.name,
              variants: model.variants ?? [],
              ...(model.defaults?.effort === undefined
                ? {}
                : { defaultEffort: model.defaults.effort }),
              ...(model.defaults?.budgets === undefined
                ? {}
                : { defaultBudgets: model.defaults.budgets }),
              ...(selected?.data === undefined
                ? {}
                : {
                    defaultModel:
                      selected.data.id === native.id &&
                      selected.data.providerID === native.providerID,
                  }),
              tools: native.capabilities.tools,
              ...(native.capabilities.responsesWebsockets === undefined
                ? {}
                : { responsesWebsockets: native.capabilities.responsesWebsockets }),
              limits: {
                context: native.limit.context,
                output: native.limit.output,
                ...(native.limit.input === undefined ? {} : { input: native.limit.input }),
              },
              modalities: { input: native.capabilities.input, output: native.capabilities.output },
              availability:
                native.enabled && configured.has(model.providerID) ? "available" : "unavailable",
            }
          })
        }).pipe(
          Effect.catch(
            (
              error,
            ): Effect.Effect<{ readonly status: "unsupported" | "unauthenticated" }, Error> => {
              const cause = "cause" in error ? error.cause : error
              if (Schema.isSchemaError(cause))
                return Effect.succeed({ status: "unsupported" as const })
              if (HttpClientError.isHttpClientError(cause) && "response" in cause.reason) {
                const status = cause.reason.response.status
                if ([401, 403].includes(status))
                  return Effect.succeed({ status: "unauthenticated" as const })
                if (
                  [404, 405, 501].includes(status) ||
                  (status < 400 && cause.reason._tag === "DecodeError")
                )
                  return Effect.succeed({ status: "unsupported" as const })
              }
              return Effect.fail(error)
            },
          ),
        ),
        { signal },
      ),
  }
}
