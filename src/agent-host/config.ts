import { lstat } from "node:fs/promises"
import { OpenCodeMigrationPolicy } from "./opencode-credentials"
import { Schema } from "effect"
const Path = Schema.String.check(Schema.isPattern(/^\/[^\0]*$/))
const Login = Schema.Struct({ canonical: Path, benLink: Path, agentLink: Path })
export const CredentialPolicy = Schema.Struct({
  root: Path,
  launch: Schema.optionalKey(
    Schema.Struct({
      repositories: Schema.optionalKey(
        Schema.Array(Schema.Struct({ source: Path, remote: Schema.String })),
      ),
      retentionMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
      custodyRoot: Path,
      ioRoot: Path,
      home: Path,
      workspaceRoot: Path,
      bun: Path,
      worker: Path,
      codex: Path,
      claude: Path,
    }),
  ),
  opencode: Schema.optionalKey(OpenCodeMigrationPolicy),
  ownerUid: Schema.Int,
  groupGid: Schema.Int,
  controllerUid: Schema.Int,
  agentUid: Schema.Int,
  codex: Login,
  claude: Login,
  consumerExecutables: Schema.Array(Path),
})
export type CredentialPolicy = typeof CredentialPolicy.Type

/** An installed isolation policy must never silently fall back to controller execution. */
export async function requireAgentHostSocket(
  socket: string | undefined,
  policyPath = "/etc/workflowd/agent-host.json",
) {
  if (socket !== undefined) {
    if (!socket.startsWith("/")) throw new Error("WORKFLOWD_AGENT_HOST_SOCKET must be absolute")
    return
  }
  const exists = await lstat(policyPath).then(
    () => true,
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
      throw error
    },
  )
  if (exists)
    throw new Error("WORKFLOWD_AGENT_HOST_SOCKET is required by the installed host policy")
}
