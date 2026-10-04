import { Effect, Schema } from "effect"
import { authorized } from "../http-auth"
import {
  ExternalRegistration,
  type DirectoryError,
  type DirectorySnapshot,
  type RegistrationReceipt,
} from "./contract"

export type DirectoryHttpBinding = {
  readonly token: string
  readonly inventory: () => Effect.Effect<DirectorySnapshot, DirectoryError>
  readonly register: (
    input: ExternalRegistration,
  ) => Effect.Effect<RegistrationReceipt, DirectoryError>
}

const notFound = () => Response.json({ error: "not found" }, { status: 404 })
function inventoryResponse(url: URL, snapshot: DirectorySnapshot) {
  const path = url.pathname
  if (path === "/directory") return Response.json(snapshot)
  if (path === "/directory/agents") return Response.json({ agents: snapshot.agents })
  if (path === "/directory/runners") return Response.json({ runners: snapshot.runners })
  if (path === "/directory/capabilities") {
    const host = url.searchParams.get("host")
    return Response.json({
      runners: snapshot.runners.filter((runner) => host === null || runner.hostId === host),
    })
  }
  const match = /^\/directory\/(agents|runners)\/([^/]+)$/.exec(path)
  if (match === null) return notFound()
  let id: string
  try {
    id = decodeURIComponent(match[2]!)
  } catch {
    return Response.json({ error: "invalid identifier" }, { status: 400 })
  }
  const value =
    match[1] === "agents"
      ? snapshot.agents.find((agent) => agent.recipientId === id)
      : snapshot.runners.find((runner) => runner.runnerId === id)
  return value === undefined ? notFound() : Response.json(value)
}

const register = Effect.fn("DirectoryHttp.register")(function* (
  request: Request,
  binding: DirectoryHttpBinding,
  maximum: number,
) {
  const text = yield* Effect.tryPromise(() => request.text()).pipe(Effect.result)
  if (text._tag === "Failure") return Response.json({ error: "invalid body" }, { status: 400 })
  if (new TextEncoder().encode(text.success).byteLength > maximum)
    return Response.json({ error: "body too large" }, { status: 413 })
  const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ExternalRegistration))(
    text.success,
    { onExcessProperty: "error" },
  ).pipe(Effect.result)
  if (input._tag === "Failure")
    return Response.json({ error: "invalid registration" }, { status: 400 })
  return yield* binding.register(input.success).pipe(
    Effect.match({
      onSuccess: (receipt) => Response.json(receipt, { status: 202 }),
      onFailure: (error) =>
        Response.json(
          { error: "registration refused", reason: error.reason },
          { status: error.reason === "unavailable" ? 503 : 409 },
        ),
    }),
  )
})

export function routeDirectory(
  request: Request,
  binding: DirectoryHttpBinding | undefined,
  maximum = 16_384,
) {
  const url = new URL(request.url)
  if (
    binding === undefined ||
    !(url.pathname === "/directory" || url.pathname.startsWith("/directory/"))
  )
    return undefined
  if (!authorized(request.headers.get("authorization"), binding.token))
    return Effect.succeed(Response.json({ error: "unauthorized" }, { status: 401 }))
  if (request.method === "POST" && url.pathname === "/directory/registrations")
    return register(request, binding, Math.min(maximum, 16_384))
  if (request.method !== "GET") return Effect.succeed(notFound())
  return binding.inventory().pipe(
    Effect.match({
      onSuccess: (snapshot) => inventoryResponse(url, snapshot),
      onFailure: () => Response.json({ error: "directory unavailable" }, { status: 503 }),
    }),
  )
}
