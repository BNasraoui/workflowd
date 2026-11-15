export const credentialPatterns = (secrets: ReadonlyArray<string>) =>
  secrets
    .filter(Boolean)
    .flatMap((value) => [
      value,
      Buffer.from(value).toString("base64"),
      Buffer.from(value).toString("base64url"),
      Buffer.from(value).toString("hex"),
      encodeURIComponent(value),
    ])
    .map((value) => Buffer.from(value))
