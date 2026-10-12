import type { AppConfig } from "./config"

export function configuredWebhookInstallations(config: AppConfig): ReadonlySet<number> {
  return new Set([
    ...(config.github?.prRepositories ?? []).map((r) => r.installationId),
    ...(config.ci?.repositories ?? []).map((r) => r.installationId),
    ...(config.agentRuns?.sandboxRepositories ?? []).map((r) => r.installationId),
    ...(config.workerIdentity?.policies ?? []).map((p) => p.installationId),
    ...(config.qrspi === undefined ? [] : [config.qrspi.installationId]),
  ])
}

export function webhookInstallationId(payload: unknown): number | undefined {
  if (typeof payload !== "object" || payload === null || !("installation" in payload))
    return undefined
  const installation = payload.installation
  if (typeof installation !== "object" || installation === null || !("id" in installation))
    return undefined
  const id = installation.id
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : undefined
}
