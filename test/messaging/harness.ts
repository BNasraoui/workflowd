import { startDirectoryDaemon as start } from "../directory/harness"
export const startDirectoryDaemon = (
  hostId: string,
  database: string,
  env: Record<string, string> = {},
) => start(hostId, database, { WORKFLOWD_MESSAGING_ENABLED: "true", ...env })
