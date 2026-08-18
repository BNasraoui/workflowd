export function parseNatsServers(
  raw: string,
  name = "WORKFLOWD_NATS_SERVERS",
): ReadonlyArray<string> {
  const servers = raw.split(",").map((server) => server.trim())
  if (servers.includes("")) {
    throw new Error(`${name} must contain at least one NATS server URL`)
  }
  for (const server of servers) {
    let parsed: URL
    try {
      parsed = new URL(server)
    } catch {
      throw new Error(`${name} contains an invalid NATS server URL`)
    }
    if (
      (parsed.protocol !== "nats:" && parsed.protocol !== "tls:") ||
      parsed.hostname === "" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      (parsed.pathname !== "" && parsed.pathname !== "/")
    ) {
      throw new Error(`${name} contains an unsafe NATS server URL`)
    }
  }
  return servers
}
