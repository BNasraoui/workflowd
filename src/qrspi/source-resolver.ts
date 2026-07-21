import { realpathSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"

export function makeWorkspaceSourceResolver(workspace: string) {
  return (source: string): boolean => {
    if (/^(?:https?:\/\/|beads:|provenance:|ticket:)/.test(source)) return false
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
