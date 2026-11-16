import { resolve } from "node:path"
import { Schema } from "effect"

/**
 * The runner job of a lease push, as GitHub runs it: the caller workflow
 * (`agent-sandbox-caller.yml`) and the reusable workflow it calls (`agent-sandbox.yml`), read from
 * the files of this repository. It evaluates the expressions of the two files that a lease push
 * reaches: the two jobs' conditions, the caller's inputs, and each step's condition and
 * environment. It gives the steps that run, each with its environment, so that a test runs them
 * as the runner does. It fails when the caller does not give an input that a step that runs
 * reads, or when the caller reads a variable that the test gives no value.
 */

const root = resolve(import.meta.dir, "../..")
export const callerPath = ".github/workflows/agent-sandbox-caller.yml"
export const reusablePath = ".github/workflows/agent-sandbox.yml"

const Step = Schema.Struct({
  name: Schema.String,
  if: Schema.optionalKey(Schema.String),
  uses: Schema.optionalKey(Schema.String),
  run: Schema.optionalKey(Schema.String),
  shell: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  with: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
})
const Job = Schema.Struct({
  if: Schema.optionalKey(Schema.String),
  uses: Schema.optionalKey(Schema.String),
  with: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  permissions: Schema.optionalKey(Schema.Json),
  steps: Schema.optionalKey(Schema.Array(Step)),
})
const Input = Schema.Struct({
  required: Schema.optionalKey(Schema.Boolean),
  default: Schema.optionalKey(Schema.String),
})
const Caller = Schema.Struct({ jobs: Schema.Record(Schema.String, Job) })
const Reusable = Schema.Struct({
  on: Schema.Struct({
    workflow_call: Schema.Struct({ inputs: Schema.Record(Schema.String, Input) }),
  }),
  jobs: Schema.Record(Schema.String, Job),
})

type Value = string | number | boolean | null
type Context = {
  readonly lookup: (path: ReadonlyArray<string>) => Value
  readonly functions: Readonly<Record<string, (...args: ReadonlyArray<Value>) => Value>>
}

const tokenPattern =
  /\s*(?:('(?:[^']|'')*')|(&&|\|\||==|!=|[()!,])|(-?\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*))/y

/** The tokens of an Actions expression; fails on any other text. */
function tokens(source: string) {
  const list: Array<{ kind: "string" | "op" | "number" | "name"; text: string }> = []
  tokenPattern.lastIndex = 0
  while (tokenPattern.lastIndex < source.length) {
    if (/^\s*$/.test(source.slice(tokenPattern.lastIndex))) break
    const match = tokenPattern.exec(source)
    if (match === null) throw new Error(`expression refused: ${source}`)
    const [, text, op, number, name] = match
    if (text !== undefined)
      list.push({ kind: "string", text: text.slice(1, -1).replace(/''/g, "'") })
    else if (op !== undefined) list.push({ kind: "op", text: op })
    else if (number !== undefined) list.push({ kind: "number", text: number })
    else list.push({ kind: "name", text: name ?? "" })
  }
  return list
}

const truthy = (value: Value) => value !== null && value !== false && value !== 0 && value !== ""
/** Equality as Actions compares: strings without case, other kinds as numbers. */
const equal = (left: Value, right: Value) =>
  typeof left === "string" && typeof right === "string"
    ? left.toLowerCase() === right.toLowerCase()
    : Number(left) === Number(right)

/** Evaluates an Actions expression (without `${{ }}`) in `context`. */
export function evaluate(source: string, context: Context): Value {
  const list = tokens(source)
  let at = 0
  const peek = () => list[at]
  const take = (text: string) => {
    if (peek()?.text !== text) throw new Error(`expression refused at ${at}: ${source}`)
    at++
  }
  const primary = (): Value => {
    const token = list[at++]
    if (token === undefined) throw new Error(`expression ends early: ${source}`)
    if (token.kind === "string") return token.text
    if (token.kind === "number") return Number(token.text)
    if (token.kind === "op" && token.text === "(") {
      const value = or()
      take(")")
      return value
    }
    if (token.kind === "op" && token.text === "!") return !truthy(primary())
    if (token.kind !== "name") throw new Error(`expression refused: ${source}`)
    if (token.text === "true") return true
    if (token.text === "false") return false
    if (token.text === "null") return null
    if (peek()?.text === "(") {
      take("(")
      const args: Array<Value> = []
      while (peek()?.text !== ")") {
        args.push(or())
        if (peek()?.text === ",") take(",")
      }
      take(")")
      const call = context.functions[token.text]
      if (call === undefined) throw new Error(`function refused: ${token.text}`)
      return call(...args)
    }
    return context.lookup(token.text.split("."))
  }
  const equality = (): Value => {
    let left = primary()
    while (peek()?.text === "==" || peek()?.text === "!=") {
      const op = list[at++]?.text
      const right = primary()
      left = op === "==" ? equal(left, right) : !equal(left, right)
    }
    return left
  }
  const and = (): Value => {
    let left = equality()
    while (peek()?.text === "&&") {
      at++
      const right = equality()
      left = truthy(left) ? right : left
    }
    return left
  }
  function or(): Value {
    let left = and()
    while (peek()?.text === "||") {
      at++
      const right = and()
      left = truthy(left) ? left : right
    }
    return left
  }
  const value = or()
  if (at !== list.length) throw new Error(`expression refused: ${source}`)
  return value
}

/** A value of a workflow file: its `${{ }}` parts evaluated in `context`. */
export function interpolate(source: string, context: Context): string {
  return source.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expression: string) => {
    const value = evaluate(expression, context)
    return value === null ? "" : String(value)
  })
}

/** The facts of the lease push: GitHub's context of the push, as the runner job sees it. */
export interface LeasePush {
  readonly leaseId: string
  readonly sha: string
  readonly repository: string
  /** The repository's id; the caller's `repository-id` input when not named. */
  readonly repositoryId?: string
  /** The App's actor id; the caller's `app-actor-id` input when not named. */
  readonly actorId?: string
}

/** One step of the runner job that runs, with its environment as the workflow gives it. */
export interface JobStep {
  readonly name: string
  readonly uses?: string
  readonly run?: string
  /** The step's shell command line, `{0}` for the script's path. */
  readonly shell: string
  readonly env: Readonly<Record<string, string>>
  readonly with: Readonly<Record<string, string>>
}

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {}
/** A scalar value of a workflow file as text; any other value fails. */
const scalar = (value: unknown): string => {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  throw new Error(`a workflow value is not a scalar: ${JSON.stringify(value)}`)
}

/**
 * The runner job of `push`, with the caller's variables `vars`: its inputs as the caller gives
 * them, and the steps that run, in order. Each read of an input by a step that runs, or by a
 * condition, must find a value the caller gives or the input's default; an input that the caller
 * does not give and that has no default fails, as does an environment value of a step that runs
 * that is empty.
 */
export async function runnerJob(
  push: LeasePush,
  vars: Readonly<Record<string, string>>,
): Promise<{
  readonly inputs: Readonly<Record<string, string>>
  readonly steps: ReadonlyArray<JobStep>
}> {
  const caller = Schema.decodeUnknownSync(Caller)(
    Bun.YAML.parse(await Bun.file(`${root}/${callerPath}`).text()),
  )
  const reusable = Schema.decodeUnknownSync(Reusable)(
    Bun.YAML.parse(await Bun.file(`${root}/${reusablePath}`).text()),
  )
  const [callerName, callerJob] =
    Object.entries(caller.jobs).find(([, job]) => job.uses === `./${reusablePath}`) ?? []
  if (callerJob === undefined) throw new Error(`${callerPath} calls no ${reusablePath}`)
  const github: Record<string, unknown> = {
    event_name: "push",
    ref: `refs/heads/workflowd/leases/${push.leaseId}`,
    sha: push.sha,
    repository: push.repository,
    repository_id: push.repositoryId ?? scalar(callerJob.with?.["repository-id"] ?? ""),
    actor_id: push.actorId ?? scalar(callerJob.with?.["app-actor-id"] ?? ""),
    run_id: "79",
    run_attempt: "1",
    event: { deleted: false, repository: { fork: false } },
  }
  const functions = {
    startsWith: (left: Value, right: Value) =>
      String(left ?? "")
        .toLowerCase()
        .startsWith(String(right ?? "").toLowerCase()),
    success: () => true,
    always: () => true,
  }
  const path = (base: unknown, keys: ReadonlyArray<string>): Value => {
    let value: unknown = base
    for (const key of keys) value = object(value)[key]
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? value
      : null
  }
  const callerContext: Context = {
    functions,
    lookup: ([scope, ...keys]) => {
      if (scope === "github") return path(github, keys)
      if (scope === "vars") {
        const name = keys.join(".")
        if (!Object.hasOwn(vars, name))
          throw new Error(`the caller reads the variable ${name}, which the trial gives no value`)
        return vars[name] ?? null
      }
      throw new Error(`the caller reads ${scope}, which a lease push does not give`)
    },
  }
  if (!truthy(evaluate(callerJob.if ?? "true", callerContext)))
    throw new Error(`${callerPath}: the condition of job ${callerName} is false for the lease push`)
  const given = Object.fromEntries(
    Object.entries(callerJob.with ?? {}).map(([name, value]) => [
      name,
      interpolate(scalar(value), callerContext),
    ]),
  )
  const declared = reusable.on.workflow_call.inputs
  for (const name of Object.keys(given))
    if (!Object.hasOwn(declared, name))
      throw new Error(
        `${callerPath} gives the input ${name}, which ${reusablePath} does not declare`,
      )
  const inputs: Record<string, string> = {}
  for (const [name, input] of Object.entries(declared)) {
    const value = given[name] ?? input.default
    if (value !== undefined) inputs[name] = value
    else if (input.required === true)
      throw new Error(`${callerPath} does not give the required input ${name}`)
  }
  const context = (step: string): Context => ({
    functions,
    lookup: ([scope, ...keys]) => {
      if (scope === "github") return path(github, keys)
      if (scope === "inputs") {
        const name = keys.join(".")
        if (!Object.hasOwn(declared, name))
          throw new Error(
            `${reusablePath}: ${step} reads the input ${name}, which it does not declare`,
          )
        return inputs[name] ?? null
      }
      throw new Error(`${reusablePath}: ${step} reads ${scope}, which this trial does not give`)
    },
  })
  const [jobName, job] = Object.entries(reusable.jobs)[0] ?? []
  if (job === undefined) throw new Error(`${reusablePath} has no job`)
  if (!truthy(evaluate(job.if ?? "true", context(`job ${jobName}`))))
    throw new Error(`${reusablePath}: the condition of job ${jobName} is false for the lease push`)
  const steps: Array<JobStep> = []
  for (const step of job.steps ?? []) {
    const scope = context(`step "${step.name}"`)
    if (!truthy(evaluate(step.if ?? "success()", scope))) continue
    const env = Object.fromEntries(
      Object.entries(step.env ?? {}).map(([name, value]) => [name, interpolate(value, scope)]),
    )
    for (const [name, value] of Object.entries(env))
      if (value === "")
        throw new Error(
          `${reusablePath}: step "${step.name}" reads ${name} from an input that ${callerPath} does not give`,
        )
    steps.push({
      name: step.name,
      ...(step.uses === undefined ? {} : { uses: step.uses }),
      ...(step.run === undefined ? {} : { run: step.run }),
      shell: step.shell ?? "bash --noprofile --norc -eo pipefail {0}",
      env,
      with: Object.fromEntries(
        Object.entries(step.with ?? {}).map(([name, value]) => [
          name,
          interpolate(scalar(value), scope),
        ]),
      ),
    })
  }
  return { inputs, steps }
}

/** Whether the job grants the runner's OIDC request authority (`id-token: write`). */
export async function grantsJobIdentity() {
  const reusable = Schema.decodeUnknownSync(Reusable)(
    Bun.YAML.parse(await Bun.file(`${root}/${reusablePath}`).text()),
  )
  const job = Object.values(reusable.jobs)[0]
  return object(job?.permissions)["id-token"] === "write"
}

/**
 * Runs the steps of the runner job in order, as the runner does: each `run` step in its shell, in
 * the tooling checkout `cwd`, with the runner's environment `base` and the step's own. A step in
 * `handOver` does not run: its value names the reason, and the test covers each side of it. A
 * `uses` step other than those fails, as does a step that ends other than 0.
 */
export async function runSteps(
  steps: ReadonlyArray<JobStep>,
  options: {
    readonly cwd: string
    readonly base: Readonly<Record<string, string>>
    readonly scripts: string
    readonly handOver: Readonly<Record<string, (step: JobStep) => void>>
  },
) {
  const ran: Array<string> = []
  for (const [index, step] of steps.entries()) {
    const handOver = options.handOver[step.name]
    if (handOver !== undefined) {
      handOver(step)
      continue
    }
    if (step.run === undefined)
      throw new Error(`step "${step.name}": the trial cannot run ${step.uses ?? "it"}`)
    const script = `${options.scripts}/step-${index}.sh`
    await Bun.write(script, step.run)
    const child = Bun.spawn(
      step.shell.split(/\s+/).map((part) => (part === "{0}" ? script : part)),
      {
        cwd: options.cwd,
        env: { ...options.base, ...step.env },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, out, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code !== 0)
      throw new Error(
        `step "${step.name}": exit ${code}: ${out.slice(-2000)} ${errors.slice(-2000)}`,
      )
    ran.push(step.name)
  }
  return ran
}
