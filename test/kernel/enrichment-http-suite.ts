import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

/**
 * The four wire behaviors every token-guarded GET enrichment route shares:
 * one authorized 200 carrying the store document, 401s that never consult
 * the store, a 404 while the surface is unconfigured, and an opaque 500 on
 * store faults. Each surface's test file only supplies its route binding.
 */
export function enrichmentHttpSuite<Document, StoreError>(options: {
  readonly title: string
  readonly token: string
  readonly document: Document
  readonly get: (headers?: Record<string, string>) => Request
  readonly route: (
    request: Request,
    sessions: () => Effect.Effect<Document, StoreError>,
  ) => Promise<Response>
  readonly routeWithoutBinding: (request: Request) => Promise<Response>
  readonly storeFailure: () => Effect.Effect<Document, StoreError>
}): void {
  const { title, token, document, get, route } = options

  describe(title, () => {
    test("serves the enrichment document to an authorized reader", async () => {
      let called = 0
      const response = await route(get({ authorization: `Bearer ${token}` }), () => {
        called += 1
        return Effect.succeed(document)
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(document)
      expect(called).toBe(1)
    })

    test("rejects a missing or wrong bearer token without consulting the store", async () => {
      let called = 0
      const sessions = () => {
        called += 1
        return Effect.succeed(document)
      }
      const missing = await route(get(), sessions)
      const wrong = await route(get({ authorization: "Bearer nope" }), sessions)

      expect(missing.status).toBe(401)
      expect(wrong.status).toBe(401)
      expect(called).toBe(0)
    })

    test("keeps the route absent when enrichment is not configured", async () => {
      const response = await options.routeWithoutBinding(get({ authorization: `Bearer ${token}` }))

      expect(response.status).toBe(404)
    })

    test("surfaces store failures as an opaque 500", async () => {
      const response = await route(get({ authorization: `Bearer ${token}` }), options.storeFailure)

      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: "internal server error" })
    })
  })
}
