import { realpathSync } from "node:fs"
import { resolve } from "node:path"

const projectDirectory = (directory: string) => {
  try {
    return realpathSync(directory)
  } catch (cause) {
    // A missing directory cannot load config; the harness will reject it at launch.
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause
    return resolve(directory)
  }
}

/** Worktree trust must override persisted repository trust on every launch/resume. */
export const codexProjectConfig = (directory: string) => ({
  projects: { [projectDirectory(directory)]: { trust_level: "untrusted" } },
})

export const codexProjectArguments = (directory: string) => [
  "-c",
  `projects={${JSON.stringify(projectDirectory(directory))}={trust_level="untrusted"}}`,
]
