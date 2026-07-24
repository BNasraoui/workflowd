import { realpathSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"

export function makeWorkspaceSourceResolver(workspace: string) {
  return (source: string): boolean => {
    if (/^(?:beads|provenance|ticket):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(source)) {
      return true
    }
    try {
      const url = new URL(source)
      if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "") {
        return true
      }
    } catch {
      // Continue with workspace-relative path resolution.
    }
    try {
      const root = realpathSync(workspace)
      const candidate = realpathSync(resolve(root, source))
      const pathFromRoot = relative(root, candidate)
      return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
    } catch {
      return false
    }
  }
}
