import { Effect } from "effect"
import { authorized } from "../http-auth"
import type { ExecutionCapabilities } from "../execution-capability-contract"

export type ExecutionDiscoveryHttpBinding = {
  readonly token: string
  readonly list: () => Effect.Effect<ExecutionCapabilities, Error>
}

export function routeExecutionDiscovery(
  request: Request,
  binding: ExecutionDiscoveryHttpBinding | undefined,
) {
  if (
    binding === undefined ||
    request.method !== "GET" ||
    new URL(request.url).pathname !== "/execution-capabilities"
  )
    return undefined
  if (!authorized(request.headers.get("authorization"), binding.token))
    return Effect.succeed(Response.json({ error: "unauthorized" }, { status: 401 }))
  return binding.list().pipe(
    Effect.match({
      onSuccess: (capabilities) => Response.json(capabilities),
      onFailure: () =>
        Response.json({ error: "capability discovery unavailable" }, { status: 503 }),
    }),
  )
}
