import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { unitLabel } from "./backend"
import { owner } from "./owner"

const realLauncher = "/run/workflowd-test-systemd-run"

/** The disposable host's private mount namespace wraps even absolute systemd-run calls. */
export function labelNativeTestUnits(
  directory = process.env.PATH!.split(":")[0]!,
  target = realLauncher,
) {
  if (
    target === realLauncher &&
    (process.getuid!() !== 0 || process.env.WORKFLOWD_AGENT_DEPLOYED_TEST !== "1")
  )
    throw new Error("Native test unit labels require the disposable CI VM")
  if (!directory.includes("workflowd-test-run-")) throw new Error("Test resource guard required")
  const assignment = `${unitLabel}=${owner()}`
  const wrapper = join(directory, "native-systemd-run")
  writeFileSync(join(directory, "used-system"), "")
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec ${quote(target)} ${quote(`--setenv=${assignment}`)} "$@"\n`,
    { mode: 0o700 },
  )
  // systemd orders mounts by destination: preserve the real executable under /run
  // before overlaying /usr/bin in this service's namespace. No host binary changes.
  return `Environment=${assignment}\nBindReadOnlyPaths=/usr/bin/systemd-run:${target}\nBindReadOnlyPaths=${wrapper}:/usr/bin/systemd-run\n`
}
