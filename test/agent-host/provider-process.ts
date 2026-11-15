import { appendFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import { makeProviderAccessOwner } from "../../src/agent-host/provider-access"
import { Schema } from "effect"

const input = createInterface({ input: process.stdin })[Symbol.asyncIterator]()
const config = Schema.decodeUnknownSync(
  Schema.Struct({
    canonical: Schema.String,
    count: Schema.String,
    now: Schema.Number,
    mode: Schema.Literals(["cooldown", "rotate", "hold", "uncertain"]),
  }),
)(JSON.parse((await input.next()).value!))
Date.now = () => config.now
const owner = makeProviderAccessOwner(
  { canonical: config.canonical, ownerUid: process.getuid!(), groupGid: process.getgid!() },
  async () => {
    await appendFile(config.count, "x", { mode: 0o600 })
    if (config.mode === "hold") {
      process.stdout.write("refresh\n")
      await input.next()
    }
    if (config.mode === "cooldown") return null
    if (config.mode === "uncertain") throw new Error("fixture uncertain")
    return {
      accessToken: "new",
      refreshToken: "next",
      expiresAt: config.now + 3600000,
      scopes: ["user:inference"],
    }
  },
)
try {
  process.stdout.write(JSON.stringify(await owner.snapshot()))
} catch (error) {
  process.stdout.write(
    JSON.stringify({ error: error instanceof Error ? error.message : "refused" }),
  )
}
await input.return?.()
