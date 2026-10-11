import { Schema } from "effect"

export const SandboxTransport = Schema.Struct({
  leaseId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,80}$/)),
  peerId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,100}$/)),
  repositoryPath: Schema.Literal("/workspace/repository"),
  address: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/)),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  knownHostsFile: Schema.String.check(Schema.isPattern(/^\/[a-zA-Z0-9/_.-]+$/)),
  identityFile: Schema.String.check(Schema.isPattern(/^\/[a-zA-Z0-9/_.-]+$/)),
})
export type SandboxTransport = typeof SandboxTransport.Type

export function sandboxSshArguments(input: SandboxTransport): ReadonlyArray<string> {
  const transport = Schema.decodeUnknownSync(SandboxTransport)(input)
  return [
    "/usr/bin/ssh",
    "-F",
    "/dev/null",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=2",
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    `UserKnownHostsFile=${transport.knownHostsFile}`,
    "-i",
    transport.identityFile,
    "-p",
    String(transport.port),
    `runner@${transport.address}`,
    "exec /usr/local/bin/container-use stdio",
  ]
}
