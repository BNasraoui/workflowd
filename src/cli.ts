#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { readFile } from "node:fs/promises"
import { Schema } from "effect"
import { AgentRunSubmission } from "./agent-run-contract"
import { RequestedSelection, validSelection } from "./execution-selection"
import { loadAgentRunDaemon, loadExecutionCapabilitiesDaemon } from "./mcp/auth"

const usage = `workflowd models list [--host HOST] [--harness HARNESS] [--family FAMILY]
workflowd job HOST [HARNESS] FAMILY --repository REPO --prompt TASK
workflowd job HOST --intent INTENT --repository REPO --prompt TASK
workflowd job status RUN_ID
workflowd job cancel RUN_ID
Options: --model ID, --version VERSION, --thinking EFFORT, --speed TIER,
         --prompt-file PATH, --idempotency-key KEY, --dry-run
Configure WORKFLOWD_DAEMON_URL and WORKFLOWD_AGENT_RUN_TOKEN[_FILE].`

function parseCliArguments(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      host: { type: "string" },
      harness: { type: "string" },
      family: { type: "string" },
      model: { type: "string" },
      repository: { type: "string" },
      prompt: { type: "string" },
      "prompt-file": { type: "string" },
      intent: { type: "string" },
      version: { type: "string" },
      thinking: { type: "string" },
      speed: { type: "string" },
      "idempotency-key": { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean" },
    },
  })
}

type CliValues = ReturnType<typeof parseCliArguments>["values"]

function jobSelection(values: CliValues, positionals: string[]) {
  const positionalHarness = positionals.length === 4 ? positionals[2] : undefined
  const positionalFamily = positionals.length === 4 ? positionals[3] : positionals[2]
  if (
    (values.host !== undefined && values.host !== positionals[1]) ||
    (values.harness !== undefined &&
      positionalHarness !== undefined &&
      values.harness !== positionalHarness) ||
    (values.family !== undefined &&
      positionalFamily !== undefined &&
      values.family !== positionalFamily)
  )
    throw new Error("Positional and named selectors must agree")
  const selection = Schema.decodeUnknownSync(RequestedSelection)({
    host: positionals[1],
    ...(positionalHarness === undefined && values.harness === undefined
      ? {}
      : { harness: positionalHarness ?? values.harness }),
    ...(positionalFamily === undefined && values.family === undefined
      ? {}
      : { family: positionalFamily ?? values.family }),
    ...(values.model === undefined ? {} : { model: values.model }),
    ...(values.intent === undefined ? {} : { intent: values.intent }),
    ...(values.version === undefined ? {} : { version: values.version }),
    ...(values.speed === undefined ? {} : { speed: values.speed }),
    ...(values.thinking === undefined ? {} : { thinking: { effort: values.thinking } }),
  })
  if (!validSelection(selection))
    throw new Error("Use a family, exact model or configured intent; version requires family")
  return selection
}

async function jobBody(values: CliValues, positionals: string[]) {
  if (values.prompt !== undefined && values["prompt-file"] !== undefined)
    throw new Error("Use one prompt source")
  const selection = jobSelection(values, positionals)
  if (values["dry-run"]) return JSON.stringify(selection)
  return JSON.stringify(
    Schema.decodeUnknownSync(AgentRunSubmission)({
      ...selection,
      repository: values.repository,
      prompt:
        values["prompt-file"] === undefined
          ? values.prompt
          : await readFile(values["prompt-file"], "utf8"),
      ...(values["idempotency-key"] === undefined
        ? {}
        : { idempotencyKey: values["idempotency-key"] }),
    }),
  )
}

function cliTarget(values: CliValues, positionals: string[]) {
  const models =
    positionals[0] === "models" && positionals[1] === "list" && positionals.length === 2
  const operation =
    positionals[0] === "job" &&
    (positionals[1] === "status" || positionals[1] === "cancel") &&
    positionals.length === 3
      ? positionals[1]
      : undefined
  if (
    !models &&
    (positionals[0] !== "job" || positionals[1] === undefined || positionals.length > 4)
  )
    throw new Error(usage)
  const pathname = models
    ? "/models"
    : operation !== undefined
      ? `/workflows/agent-runs/${encodeURIComponent(positionals[2] ?? "")}`
      : values["dry-run"]
        ? "/execution-selections/resolve"
        : "/workflows/agent-runs"
  const method =
    models || operation === "status" ? "GET" : operation === "cancel" ? "DELETE" : "POST"
  return { models, operation, pathname, method }
}

export async function runCli(
  args: string[],
  options: {
    readonly env?: Record<string, string | undefined>
    readonly send?: (url: URL, init: RequestInit) => Promise<Response>
    readonly log?: (text: string) => void
  } = {},
): Promise<number> {
  const env = options.env ?? process.env
  const send = options.send ?? fetch
  const log = options.log ?? console.log
  const { values, positionals } = parseCliArguments(args)
  if (values.help || positionals.length === 0) {
    log(usage)
    return 0
  }
  const { models, operation, pathname, method } = cliTarget(values, positionals)
  const daemon =
    models || values["dry-run"]
      ? await loadExecutionCapabilitiesDaemon(env)
      : await loadAgentRunDaemon(env)
  if (daemon === undefined)
    throw new Error("Configure the daemon URL and token before using workflowd")
  let body: string | undefined
  const url = new URL(pathname, daemon.baseUrl)
  if (models) {
    for (const key of ["host", "harness", "family"] as const)
      if (values[key] !== undefined) url.searchParams.set(key, values[key])
  } else if (operation === undefined) {
    body = await jobBody(values, positionals)
  }
  const response = await send(url, {
    method,
    headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(models || values["dry-run"] ? 35_000 : 180_000),
  })
  const result: unknown = response.status === 204 ? { status: "cancelled" } : await response.json()
  log(JSON.stringify(result, null, 2))
  return response.ok ? 0 : 2
}

if (import.meta.main)
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    () => {
      console.error(
        "workflowd command failed; check arguments, daemon configuration and availability. Use --help for usage.",
      )
      process.exitCode = 2
    },
  )
