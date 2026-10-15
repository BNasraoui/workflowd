import { spawnSync } from "node:child_process"
import type { Backend, Resource } from "./reaper"

export const label = "io.workflowd.test-run"
export const unitLabel = "WORKFLOWD_TEST_RESOURCE_RUN"
export type Config = {
  owner: string
  launcher: string
  directory: string
  docker: string | null
  systemdRun: string | null
  systemctl: string | null
  env: NodeJS.ProcessEnv
}

export function command(config: Config, args: string[], timeout = 20000): string {
  const result = spawnSync(args[0]!, args.slice(1), {
    env: config.env,
    encoding: "utf8",
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.error || result.status !== 0)
    throw new Error(
      `${args[0]} ${args.slice(1, 3).join(" ")}: ${result.error?.message ?? result.stderr}`,
    )
  return result.stdout.trim()
}
const lines = (value: string) => value.split("\n").filter(Boolean)

export function dockerBackend(config: Config, selector?: string): Backend {
  const docker = (...args: string[]) =>
    command(config, [config.docker!, "--context", "default", ...args])
  const inspect = (kind: string, id: string) => {
    try {
      const value = docker(
        kind,
        "inspect",
        "--format",
        `{{index .${kind === "container" ? "Config.Labels" : "Labels"} "${label}"}}`,
        id,
      )
      if (kind === "container" && value) {
        const image = docker("container", "inspect", "--format", "{{.Image}}", id)
        const inherited = docker(
          "image",
          "inspect",
          "--format",
          `{{index .Config.Labels "${label}"}}`,
          image,
        )
        if (value === inherited) return undefined
      }
      return value
    } catch (error) {
      if (
        error instanceof Error &&
        /[Nn]o such (container|object|network|volume)|[Nn]o such volume/.test(error.message)
      )
        return undefined
      throw error
    }
  }
  return {
    list: () =>
      ["container", "network", "volume"].flatMap((kind) =>
        lines(
          docker(
            kind,
            "ls",
            ...(kind === "container" ? ["--all"] : []),
            "--quiet",
            "--filter",
            `label=${label}`,
            ...(selector ? ["--filter", `label=${selector}`] : []),
          ),
        ).flatMap((id) => {
          const owner = inspect(kind, id)
          return owner ? [{ kind, id, owner }] : []
        }),
      ),
    remove: (resource) => {
      // Names (especially volumes and units) may have been reused after inventory.
      if (inspect(resource.kind, resource.id) !== resource.owner) return
      docker(
        resource.kind,
        "rm",
        ...(resource.kind === "container" ? ["--force"] : []),
        resource.id,
      )
    },
  }
}

// systemctl show serializes Environment as whitespace-separated C-escaped words.
// Quotes group an entire assignment; text inside another variable is not a label.
function environmentOwner(value: string): string | undefined {
  const entries = value.match(/(?:[^\s"\\]|\\.|"(?:[^"\\]|\\.)*")+/g) ?? []
  for (const entry of entries) {
    const decoded = entry
      .replace(/^"(.*)"$/, "$1")
      .replace(/\\(x[0-9a-fA-F]{2}|[0-7]{3}|.)/g, (_, escape: string) => {
        if (escape.startsWith("x")) return String.fromCharCode(parseInt(escape.slice(1), 16))
        if (/^[0-7]{3}$/.test(escape)) return String.fromCharCode(parseInt(escape, 8))
        return ({ n: "\n", r: "\r", t: "\t", s: " " } as Record<string, string>)[escape] ?? escape
      })
    if (decoded.startsWith(`${unitLabel}=`)) return decoded.slice(unitLabel.length + 1)
  }
  return undefined
}

export function systemdBackend(config: Config, user: boolean): Backend {
  const ctl = (...args: string[]) =>
    command(config, [config.systemctl!, ...(user ? ["--user"] : []), ...args])
  const inspect = (id: string) => {
    const environment = ctl("show", id, "--property=Environment", "--value")
    return environmentOwner(environment)
  }
  return {
    list: () =>
      ctl("show", "*", "--property=Id,Environment,ActiveState")
        .split("\n\n")
        .flatMap((block) => {
          if (/^ActiveState=inactive$/m.test(block)) return []
          const id = /^Id=(.+)$/m.exec(block)?.[1]
          const owner = environmentOwner(/^Environment=(.*)$/m.exec(block)?.[1] ?? "")
          return id && owner ? [{ kind: "unit", id, owner }] : []
        }),
    remove: (resource: Resource) => {
      if (inspect(resource.id) !== resource.owner) return
      ctl("stop", resource.id)
      // Failed transient units otherwise remain loaded after stop.
      try {
        ctl("reset-failed", resource.id)
      } catch {
        /* collected units are already gone */
      }
    },
  }
}
