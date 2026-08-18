import { apply, plan } from "@quality-sh/provenance"
import { qrspiSpec } from "../provenance/qrspi.spec"

const command = process.argv[2]

if (command === "plan") {
  console.log(JSON.stringify(await plan(qrspiSpec), null, 2))
} else if (command === "apply") {
  console.log(JSON.stringify(await apply(qrspiSpec), null, 2))
} else {
  throw new Error("usage: bun scripts/provenance.ts <plan|apply>")
}
