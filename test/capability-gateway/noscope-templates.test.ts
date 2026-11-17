import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

/**
 * The noscope provider templates of deploy/noscope/, which the owner installs for the gateway's
 * container (docs/runner-placement.md): each mint command starts the image's own Bun on a file of
 * the image's application, at the paths that nix/gateway-image.nix gives them, so a template runs
 * in the container that deploy/systemd/workflowd-gateway.service starts.
 */

/** The image's Bun and application root, from its entrypoint and its working directory. */
async function imagePaths() {
  const nix = await readFile(resolve("nix/gateway-image.nix"), "utf8")
  const entrypoint = /Entrypoint = \[ "([^"]+)" "([^"]+)" \];/.exec(nix)
  const workingDir = /WorkingDir = "([^"]+)";/.exec(nix)
  if (entrypoint === null || workingDir === null) throw new Error("the image names no entrypoint")
  // The entrypoint's script is the gateway's server, below the application root.
  expect(entrypoint[2]).toBe(`${workingDir[1]}/src/capability-gateway-server.ts`)
  // The application root is a link to the gateway's source, with src/ in its file set.
  expect(nix).toContain(`ln -s \${app} ${workingDir[1]!.slice(1)}`)
  expect(nix).toContain("../src")
  return { bun: entrypoint[1]!, app: workingDir[1]! }
}

/** The words of a template's mint command. */
async function mint(name: string) {
  const text = await readFile(resolve(`deploy/noscope/${name}.toml`), "utf8")
  const words = /^mint = "(.*)"$/m.exec(text)?.[1]?.split(" ")
  if (words === undefined) throw new Error(`${name} has no mint command`)
  return words
}

test("each noscope template starts the gateway image's Bun on a source file of the image's application", async () => {
  const { bun, app } = await imagePaths()
  expect(bun).toBe("/bin/bun")
  expect(app).toBe("/app")
  for (const name of ["run-capability", "provider-access"]) {
    const [binary, script] = await mint(name)
    expect({ name, binary }).toEqual({ name, binary: bun })
    expect(script?.startsWith(`${app}/src/`)).toBe(true)
    // The script is a file of this checkout's src/, which the image's application holds.
    expect(existsSync(resolve(script!.slice(app.length + 1)))).toBe(true)
  }
  expect(await mint("run-capability")).toEqual([
    bun,
    `${app}/src/capability-gateway/noscope-provider.ts`,
    "run",
    "{ttl}",
  ])
})

test("the example environment of the gateway's unit names the image's noscope and the noscope configuration that the templates go in", async () => {
  const example = await readFile(resolve("deploy/gateway.env.example"), "utf8")
  const config = /^WORKFLOWD_CAPABILITY_GATEWAY='(.*)'$/m.exec(example)?.[1]
  expect(config).toBeDefined()
  // noscope is a package of the image's contents; its binary is at the image's /bin.
  expect(await readFile(resolve("nix/gateway-image.nix"), "utf8")).toContain(
    "contents = [ bun noscope ];",
  )
  expect(config).toContain(
    '"noscope":{"binary":"/bin/noscope","configHome":"/var/lib/workflowd-gateway/config"}',
  )
})
