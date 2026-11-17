export const resultBounds: {
  readonly blobBytes: number
  readonly changedBytes: number
  readonly changedPaths: number
  readonly commits: number
  readonly objects: number
  readonly objectBytes: number
}
export const resultRules: string
export function pathRefusal(path: string): "path_name" | "github_path" | "protected_path" | undefined
export function pathKey(path: string): string
export function credentialShaped(bytes: Uint8Array): boolean
