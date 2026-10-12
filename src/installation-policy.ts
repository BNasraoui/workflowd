const setting = "WORKFLOWD_ALLOWED_INSTALLATION_ACCOUNT_IDS"

export function parseInstallationAccountIds(value: string | undefined): ReadonlyArray<number> {
  const parts = value?.split(",").map((part) => part.trim()) ?? []
  if (parts.length === 0 || parts.some((part) => !/^[1-9][0-9]*$/.test(part))) {
    throw new Error(`${setting} must contain comma-separated positive account IDs`)
  }
  return validateInstallationAccountIds(parts.map(Number))
}

export function validateInstallationAccountIds(ids: ReadonlyArray<number>): ReadonlyArray<number> {
  if (
    ids.length === 0 ||
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error(`${setting} must contain unique positive safe integer account IDs`)
  }
  return ids
}
