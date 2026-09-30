#!/usr/bin/env bun
// Administrative cancellation through the real store, never a fabricated row.
import { realpathSync } from "node:fs"
import { resolve, sep } from "node:path"
import { Effect, Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store.ts"

const [filename, runId] = process.argv.slice(2)
const scratch = resolve(import.meta.dirname, "../../.scratch/evidence") + sep
if (!filename || !realpathSync(filename).startsWith(scratch) || !runId)
  throw new Error("Only an existing evidence database and run ID are allowed")
await Effect.runPromise(
  Effect.flatMap(AgentRunStore, (store) =>
    store.cancel({
      runId,
      diagnostic: "isolated evidence administrative cancellation",
      now: new Date(),
    }),
  ).pipe(Effect.provide(AgentRunStoreLive.pipe(Layer.provide(SqliteClient.layer({ filename }))))),
)
console.log(
  JSON.stringify({ at: new Date().toISOString(), runId, operation: "AgentRunStore.cancel" }),
)
