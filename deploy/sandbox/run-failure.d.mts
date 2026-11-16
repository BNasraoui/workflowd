export const runFailurePrefix: string
export const runFailureCauses: ReadonlyArray<string>
export const runFailureDetailCharacters: number
export function runFailureLine(cause: string, detail: unknown): string
export function parseRunFailure(
  line: string,
): { readonly cause: string; readonly detail: string } | undefined
