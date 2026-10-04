import { query } from "@anthropic-ai/claude-agent-sdk"
import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { Schema } from "effect"
import type { DiscoverySource, ExecutionModel } from "../execution-capabilities"

const Models = Schema.Array(
  Schema.Struct({
    value: Schema.String,
    resolvedModel: Schema.optionalKey(Schema.String),
    displayName: Schema.String,
    supportedEffortLevels: Schema.optionalKey(Schema.Array(Schema.String)),
    supportsFastMode: Schema.optionalKey(Schema.Boolean),
  }),
)

/** Initialization only: streaming input is held until teardown, so no user turn can run. */
export function makeClaudeDiscovery(
  executor: string,
  binary: string,
  directory = homedir(),
): DiscoverySource {
  return {
    executor,
    kind: "claude",
    protocol: "claude-agent-sdk/supportedModels",
    discover: async (signal) => {
      signal.throwIfAborted()
      const resolvedBinary = Bun.which(binary)
      if (resolvedBinary === null) return { status: "unsupported" }
      const inputDone = Promise.withResolvers<void>()
      const children: Array<{ pid: number; exited: Promise<void> }> = []
      const killChildren = () => {
        for (const child of children) {
          try {
            process.kill(-child.pid, "SIGKILL")
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
          }
        }
      }
      signal.addEventListener("abort", killChildren, { once: true })
      const observation = query({
        prompt: {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                await inputDone.promise
                return { done: true as const, value: undefined }
              },
            }
          },
        },
        options: {
          pathToClaudeCodeExecutable: resolvedBinary,
          cwd: directory,
          persistSession: false,
          strictMcpConfig: true,
          tools: [],
          spawnClaudeCodeProcess: (options) => {
            signal.throwIfAborted()
            const child = spawn(options.command, options.args, {
              cwd: options.cwd,
              env: options.env,
              stdio: ["pipe", "pipe", "ignore"],
              detached: true,
            })
            const exited = new Promise<void>((resolve) => {
              child.once("exit", () => resolve())
              child.once("error", () => resolve())
            })
            if (child.pid !== undefined) children.push({ pid: child.pid, exited })
            return child
          },
        },
      })
      try {
        const models = Schema.decodeUnknownSync(Models)(await observation.supportedModels())
        return models
          .flatMap((model): ExecutionModel[] => {
            const native =
              model.resolvedModel ?? (model.value.startsWith("claude-") ? model.value : undefined)
            if (native === undefined) return []
            return [
              {
                provider: null,
                model: native,
                selectionModel: native,
                name: model.displayName,
                ...(model.supportedEffortLevels === undefined
                  ? {}
                  : { efforts: model.supportedEffortLevels.map((id) => ({ id })) }),
                speed:
                  model.supportsFastMode === undefined
                    ? { status: "unknown" }
                    : {
                        status: "advertised",
                        tiers: [
                          { id: "standard" },
                          ...(model.supportsFastMode ? [{ id: "fast", native: "fastMode" }] : []),
                        ],
                      },
                availability: "unknown",
              },
            ]
          })
          .filter((model, index, all) => all.findIndex((m) => m.model === model.model) === index)
      } catch (error) {
        if (Schema.isSchemaError(error)) return { status: "unsupported" }
        throw error
      } finally {
        inputDone.resolve()
        observation.close()
        killChildren()
        await Promise.all(children.map((child) => child.exited))
        signal.removeEventListener("abort", killChildren)
      }
    },
  }
}
