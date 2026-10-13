import { OpenCodeMigrationPolicy } from "./opencode-credentials"
import { Schema } from "effect"
const Path = Schema.String.check(Schema.isPattern(/^\/[^\0]*$/))
const Login = Schema.Struct({ canonical: Path, benLink: Path, agentLink: Path })
export const CredentialPolicy = Schema.Struct({
  root: Path,
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
