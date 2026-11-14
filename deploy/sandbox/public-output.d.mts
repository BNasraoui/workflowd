export function serializePublicStatus(input: Readonly<Record<string, unknown>>): string
export const publicBootstrapFields: Readonly<{
  tailscaleClientId: RegExp
  tailscaleAudience: RegExp
}>
export function publicBootstrapConfiguration(input: Readonly<Record<string, unknown>>): {
  tailscaleClientId: string
  tailscaleAudience: string
}
