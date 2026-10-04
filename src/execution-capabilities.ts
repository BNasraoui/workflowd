import { Context, Effect } from "effect"
import type {
  ExecutionCapabilities,
  ExecutionCapability,
  ExecutionThinking,
} from "./execution-capability-contract"

/** Adapters return only public metadata. Native dialects and credentials stay inside the adapter. */
export type ExecutionModel = {
  readonly provider: string | null
  readonly model: string
  readonly selectionModel?: string
  readonly name?: string
  readonly variants?: ExecutionThinking["variants"]
  readonly reasoning?: { readonly supported: boolean }
  readonly efforts?: ExecutionThinking["efforts"]
  readonly defaultEffort?: string
  readonly defaultBudgets?: ExecutionThinking["defaultBudgets"]
  readonly defaultModel?: boolean
  readonly pickerEligible?: boolean
  readonly tools?: boolean
  readonly responsesWebsockets?: boolean
  readonly limits?: ExecutionCapability["limits"]
  readonly modalities?: ExecutionCapability["modalities"]
  readonly availability?: ExecutionCapability["availability"]
  readonly speed?: ExecutionCapability["speed"]
}

export type DiscoverySource = {
  readonly executor: string
  readonly kind?: string
  readonly protocol?: string
  /** Abort ends the observation; settle only after owned native resources have been released. */
  readonly discover: (
    signal: AbortSignal,
  ) => Promise<
    ReadonlyArray<ExecutionModel> | { readonly status: "unsupported" | "unauthenticated" }
  >
}

export const ExecutionDiscovery = Context.Service<{
  readonly list: () => Effect.Effect<ExecutionCapabilities, Error>
}>("workflowd/ExecutionDiscovery")

export function makeExecutionCapabilities(options: {
  readonly host: string
  readonly sources: ReadonlyArray<DiscoverySource>
  readonly refreshMs: number
  readonly timeoutMs: number
  readonly now?: () => number
}): { readonly list: () => Promise<ExecutionCapabilities>; readonly close: () => Promise<void> } {
  const now = options.now ?? Date.now
  let closed = false
  let closing: Promise<void> | undefined
  const refreshes = new Set<{ controller: AbortController; completion: Promise<void> }>()
  type Observation = {
    checkedAt: number
    observedAt: number | null
    status: ExecutionCapabilities["sources"][number]["status"]
    models: ReadonlyArray<ExecutionModel>
  }
  // Each enabled source owns one last observation and one refresh. This retains
  // the last successful timestamp after failure without retaining stale models.
  const sources = options.sources.map((source) => {
    let previous: Observation | undefined
    let pending: Promise<Observation> | undefined
    const refresh = (): Promise<Observation> => {
      if (pending) return pending
      const controller = new AbortController()
      const native = Promise.resolve().then(() => {
        controller.signal.throwIfAborted()
        return source.discover(controller.signal)
      })
      const operation = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const abort = Promise.withResolvers<never>()
        const cancelled = () => abort.reject(new Error("Discovery cancelled"))
        controller.signal.addEventListener("abort", cancelled, { once: true })
        try {
          timer = setTimeout(() => controller.abort(), options.timeoutMs)
          const result = await Promise.race([native, abort.promise])
          const at = now()
          previous =
            "status" in result
              ? {
                  checkedAt: at,
                  observedAt: previous?.observedAt ?? null,
                  status: result.status,
                  models: [],
                }
              : { checkedAt: at, observedAt: at, status: "available", models: result }
        } catch {
          previous = {
            checkedAt: now(),
            observedAt: previous?.observedAt ?? null,
            status: "unavailable",
            models: [],
          }
        } finally {
          clearTimeout(timer)
          controller.signal.removeEventListener("abort", cancelled)
        }
        return previous
      })()
      // A bounded read can finish before native teardown. Keep ownership and
      // coalescing until both settle, so disposal joins the actual adapter cleanup.
      const owned = {
        controller,
        completion: Promise.allSettled([native, operation]).then(() => {
          pending = undefined
          refreshes.delete(owned)
        }),
      }
      refreshes.add(owned)
      pending = operation
      return operation
    }
    return {
      source,
      read: () =>
        previous && now() - previous.checkedAt < options.refreshMs
          ? Promise.resolve(previous)
          : refresh(),
    }
  })
  const list = async () => {
    if (closed) throw new Error("Capability discovery closed")
    const results = await Promise.all(
      sources.map(async ({ source, read }) => {
        return { source, observation: await read() }
      }),
    )
    if (closed) throw new Error("Capability discovery closed")
    return {
      sources: results.map(({ source, observation }) => ({
        host: options.host,
        executor: source.executor,
        kind: source.kind ?? source.executor,
        protocol: source.protocol ?? "unknown",
        status: observation.status,
        checkedAt: new Date(observation.checkedAt).toISOString(),
        observedAt:
          observation.observedAt === null ? null : new Date(observation.observedAt).toISOString(),
        freshUntil:
          observation.observedAt === null
            ? null
            : new Date(observation.observedAt + options.refreshMs).toISOString(),
        stale:
          observation.observedAt !== null &&
          (observation.status !== "available" ||
            now() - observation.observedAt >= options.refreshMs),
      })),
      capabilities: results.flatMap(({ source, observation }) =>
        observation.status !== "available" || now() - observation.checkedAt >= options.refreshMs
          ? []
          : observation.models.map((model) => ({
              identity: {
                host: options.host,
                executor: source.executor,
                provider: model.provider,
                model: model.model,
              },
              selectionModel: model.selectionModel ?? model.model,
              ...(model.speed === undefined ? {} : { speed: model.speed }),
              ...(model.name === undefined ? {} : { name: model.name }),
              thinking: {
                status:
                  model.variants !== undefined || model.efforts !== undefined
                    ? ("advertised" as const)
                    : model.reasoning?.supported === false
                      ? ("unsupported" as const)
                      : ("unknown" as const),
                ...(model.variants === undefined ? {} : { variants: model.variants }),
                ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
                ...(model.efforts === undefined ? {} : { efforts: model.efforts }),
                ...(model.defaultEffort === undefined
                  ? {}
                  : { defaultEffort: model.defaultEffort }),
                ...(model.defaultBudgets === undefined
                  ? {}
                  : { defaultBudgets: model.defaultBudgets }),
              },
              ...(model.defaultModel === undefined ? {} : { defaultModel: model.defaultModel }),
              ...(model.pickerEligible === undefined
                ? {}
                : { pickerEligible: model.pickerEligible }),
              ...(model.tools === undefined ? {} : { tools: model.tools }),
              ...(model.responsesWebsockets === undefined
                ? {}
                : { responsesWebsockets: model.responsesWebsockets }),
              ...(model.limits === undefined ? {} : { limits: model.limits }),
              ...(model.modalities === undefined ? {} : { modalities: model.modalities }),
              observedAt: new Date(observation.checkedAt).toISOString(),
              availability: model.availability ?? ("unknown" as const),
            })),
      ),
    }
  }
  return {
    list,
    close: () => {
      if (closing) return closing
      closed = true
      for (const refresh of refreshes) refresh.controller.abort()
      closing = Promise.all(Array.from(refreshes, (refresh) => refresh.completion)).then(() => {})
      return closing
    },
  }
}
