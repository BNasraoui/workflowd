export function sealRun(options: {
  readonly directory: string
  readonly native: string
  readonly sourceSha: string
  readonly identity: { readonly name: string; readonly email: string }
  readonly reply: string
}): Promise<void>
