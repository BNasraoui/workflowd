import { fixtureLabel } from "./fixture"
import { command, type Config, label } from "./backend"

/** Explicitly create image-declared and CLI volumes: Docker cannot label anonymous volumes after creation. */
export function containerArgs(config: Config, args: string[]): string[] {
  const docker = (...args: string[]) =>
    command(config, [config.docker!, "--context", "default", ...args])
  const fixture = args.find((arg) => arg.startsWith(`${fixtureLabel}=`))
  const mounts = new Set<string>()
  const prefix: string[] = []
  const flags = new Set([
    "-d",
    "--detach",
    "-i",
    "--interactive",
    "-t",
    "--tty",
    "--rm",
    "--privileged",
    "--read-only",
    "--init",
  ])
  let index = args[0] === "container" ? 2 : 1
  const volume = (name?: string) => {
    name ??= `workflowd-test-${crypto.randomUUID()}`
    let existing: string | undefined
    try {
      existing = docker("volume", "inspect", "--format", `{{index .Labels "${label}"}}`, name)
    } catch {
      /* create below; engine errors still fail create */
    }
    if (existing !== undefined && existing !== config.owner)
      throw new Error(`Refusing non-owned test volume ${name}`)
    if (existing === undefined)
      docker(
        "volume",
        "create",
        "--label",
        `${label}=${config.owner}`,
        ...(fixture ? ["--label", fixture] : []),
        name,
      )
    return name
  }
  for (; index < args.length; index++) {
    const arg = args[index]!
    if (!arg.startsWith("-")) break
    if (flags.has(arg)) continue
    const [key, inline] = arg.split("=", 2)
    const value = inline ?? args[++index]!
    if (key === "-v" || key === "--volume") {
      const fields = value.split(":")
      if (fields.length === 1) fields.unshift(volume())
      else if (!fields[0]!.startsWith("/")) volume(fields[0])
      mounts.add(fields[1]!)
      args[index] = inline === undefined ? fields.join(":") : `${key}=${fields.join(":")}`
    } else if (key === "--mount") {
      const options: Record<string, string | undefined> = Object.fromEntries(
        value.split(",").map((part) => part.split("=", 2)),
      )
      mounts.add(options.target ?? options.dst ?? options.destination!)
      if (options.type === "volume") {
        const source = options.source ?? options.src
        const name = volume(source)
        if (!source) args[index] = `${inline === undefined ? "" : `${key}=`}${value},source=${name}`
      }
    } else if (key === "--tmpfs") mounts.add(value.split(":")[0]!)
    else if (key === "--volumes-from") throw new Error("Test volumes must have explicit ownership")
  }
  const image = args[index]
  if (!image) throw new Error("Missing test container image")
  let volumes: string
  try {
    volumes = docker("image", "inspect", "--format", "{{json .Config.Volumes}}", image)
  } catch {
    docker("pull", image)
    volumes = docker("image", "inspect", "--format", "{{json .Config.Volumes}}", image)
  }
  const declared: Record<string, object> | null = JSON.parse(volumes)
  for (const path of Object.keys(declared ?? {}))
    if (!mounts.has(path)) prefix.push("--volume", `${volume()}:${path}`)
  args.splice(index, 0, ...prefix)
  return args
}
