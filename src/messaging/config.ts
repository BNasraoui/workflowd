export const loadMessagingConfig = (
  env: Record<string, string | undefined>,
  configured: boolean,
): { readonly messagingEnabled?: boolean } => {
  const value = env.WORKFLOWD_MESSAGING_ENABLED ?? "false"
  if (value !== "true" && value !== "false")
    throw new Error("WORKFLOWD_MESSAGING_ENABLED must be true or false")
  if (value === "true" && !configured)
    throw new Error("Messaging requires host discovery/enrollment configuration")
  return value === "true" ? { messagingEnabled: true } : {}
}
