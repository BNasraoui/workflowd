export const messagingEnabled = (env: Record<string, string | undefined>) => {
  const value = env.WORKFLOWD_MESSAGING_ENABLED ?? "false"
  if (value !== "true" && value !== "false")
    throw new Error("WORKFLOWD_MESSAGING_ENABLED must be true or false")
  return value === "true"
}
