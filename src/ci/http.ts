import { createHash, timingSafeEqual } from "node:crypto"
import { Effect, Schema } from "effect"
import type { CiConfig } from "./config"
import { CiTarget } from "./event"
import type { CiStore } from "./store"

export const routeCi = Effect.fn("Ci.http")(function* (
  request: Request,
  config: Pick<CiConfig, "token" | "repositories">,
  store: CiStore | undefined,
) {
  const url = new URL(request.url)
  if (!["/ci/state", "/ci/events"].includes(url.pathname)) return undefined
  if (request.method !== "GET") return new Response(null, { status: 405 })
  const supplied = createHash("sha256")
    .update(request.headers.get("authorization") ?? "")
    .digest()
  const expected = createHash("sha256").update(`Bearer ${config.token}`).digest()
  if (!timingSafeEqual(supplied, expected)) return new Response(null, { status: 401 })
  const decoded = yield* Schema.decodeUnknownEffect(CiTarget)({
    repository: url.searchParams.get("repo"),
    sha: url.searchParams.get("sha"),
  }).pipe(Effect.result)
  if (decoded._tag === "Failure") return new Response(null, { status: 400 })
  const target = decoded.success
  const repository = config.repositories.find((r) => r.repository === target.repository)
  if (repository === undefined) return new Response(null, { status: 403 })
  if (store === undefined) return new Response(null, { status: 503 })
  const after = Number(url.searchParams.get("after") ?? "0")
  if (!Number.isSafeInteger(after) || after < 0) return new Response(null, { status: 400 })
  yield* store.watch(target, repository.installationId, repository.workflows, Date.now())
  if (url.pathname === "/ci/state")
    return Response.json(
      (yield* store.read(target)) ?? {
        ...target,
        sequence: 0,
        conclusion: "pending",
        failingJobs: [],
      },
    )
  // Replay is from the SQLite sequence, independent of JetStream retention.
  // This bounded long-poll owns no provider API request and releases on cancellation.
  for (let attempt = 0; attempt < 50; attempt++) {
    const events = yield* store.events(target, after)
    if (events.length > 0) return Response.json(events)
    if (request.signal.aborted) return new Response(null, { status: 499 })
    yield* Effect.sleep(1000)
  }
  return Response.json([])
})
