import { SqliteClient } from "@effect/sql-sqlite-bun"
import type { SqlClient as SqlClientService } from "@effect/sql/SqlClient"
import { Effect, Layer } from "effect"
import { KernelSessionStoreLive, type KernelSessionStorePort } from "../../src/kernel/session-store"
import { WorkflowStoreLive } from "../../src/store"

export const sessionKernelLayer = (filename: string) => {
  const database = SqliteClient.layer({ filename })
  const bootstrap = WorkflowStoreLive.pipe(Layer.provideMerge(database))
  return KernelSessionStoreLive.pipe(Layer.provideMerge(bootstrap))
}

export const runSessionKernel = <A, E>(
  filename: string,
  effect: Effect.Effect<A, E, KernelSessionStorePort | SqlClientService>,
) => Effect.runPromise(effect.pipe(Effect.provide(sessionKernelLayer(filename))))
