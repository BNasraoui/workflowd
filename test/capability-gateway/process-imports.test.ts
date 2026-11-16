import { expect, test } from "bun:test"
import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

/**
 * workflowd and its capability gateway are two processes with two stores; they share only
 * src/capability-control/. ESLint checks each module's own imports; this test follows every
 * import that a process loads, from its entry, through any number of modules. A type-only import
 * loads no module, so it is not followed.
 */
const src = resolve(import.meta.dir, "../../src")
const transpiler = new Bun.Transpiler({ loader: "ts" })

/** The module that `specifier` names from `from`, or undefined for a package or a built-in. */
function resolveModule(from: string, specifier: string) {
  if (!specifier.startsWith(".")) return undefined
  const base = resolve(dirname(from), specifier)
  const found = [base, `${base}.ts`, join(base, "index.ts")].find(
    (path) => existsSync(path) && statSync(path).isFile(),
  )
  if (found === undefined) throw new Error(`${relative(src, from)} imports ${specifier}`)
  return found
}

/** Each module that `entry` loads, itself included, as a path relative to src. */
function loaded(entry: string) {
  const seen = new Set<string>()
  const visit = (path: string) => {
    if (seen.has(path)) return
    seen.add(path)
    if (!/\.(ts|mjs|js)$/.test(path)) return
    for (const { path: specifier } of transpiler.scanImports(readFileSync(path, "utf8"))) {
      const next = resolveModule(path, specifier)
      if (next !== undefined) visit(next)
    }
  }
  visit(join(src, entry))
  return [...seen].map((path) => relative(src, path)).sort()
}

/** The modules of workflowd's store, as ESLint's rule names them. */
const workflowdStore =
  /^(store\.ts|store\/(?!run-lifetime\.ts$).+|kernel\/.*store.*|sandbox\/(store|capability-control)\.ts|qrspi\/store\.ts)$/
const gatewayModule = /^capability-gateway(\/|-server\.ts$)/

test("the gateway's process loads no module of workflowd's store, through any module", () => {
  const modules = loaded("capability-gateway-server.ts")
  expect(modules).toContain("capability-gateway/service.ts")
  expect(modules.filter((path) => workflowdStore.test(path))).toEqual([])
})

test("no process of workflowd loads a module of the capability gateway, through any module", () => {
  for (const entry of [
    "main.ts",
    "mcp-server.ts",
    "mcp-channel.ts",
    "remote-enqueue.ts",
    "remote-process.ts",
    "remote-runner.ts",
    "config-reload-signal.ts",
  ]) {
    const modules = loaded(entry)
    expect(modules).toContain(entry)
    expect({ entry, gateway: modules.filter((path) => gatewayModule.test(path)) }).toEqual({
      entry,
      gateway: [],
    })
  }
})
