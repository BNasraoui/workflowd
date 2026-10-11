import { dirname, join } from "node:path"
import { Schema } from "effect"
import { SandboxCompletion } from "./config"
import {
  assertBridgeBinding,
  bindingDirectory,
  readSandboxBinding,
  SandboxSessionBinding,
  saveSandboxFile,
} from "./binding"
import type { SandboxTransport } from "./transport"

const Submission = Schema.Struct({
  binding: SandboxSessionBinding,
  completion: SandboxCompletion,
})

export const submitResultTool = {
  name: "submit_result",
  description:
    "Finish your task by submitting the exact result environment ID and the branch name you choose. Only the first valid submission is accepted.",
  inputSchema: Schema.decodeUnknownSync(Schema.Json)(
    Schema.toJsonSchemaDocument(SandboxCompletion).schema,
  ),
}

export async function submitSandboxResult(
  file: string,
  transport: SandboxTransport,
  args: unknown,
) {
  const binding = await assertBridgeBinding(file, transport)
  const decoded = Schema.decodeUnknownOption(SandboxCompletion)(args, { onExcessProperty: "error" })
  if (decoded._tag === "None")
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "submit_result requires exactly {environmentId: non-empty string, branch: string}",
        },
      ],
    }
  const accepted = await saveSandboxFile(
    dirname(file),
    "submission.json",
    JSON.stringify({ binding, completion: decoded.value }),
    true,
  )
  await assertBridgeBinding(file, transport)
  return {
    isError: !accepted,
    content: [
      {
        type: "text",
        text: accepted
          ? "Result submitted."
          : "Result already submitted for this binding; the first valid submission wins.",
      },
    ],
  }
}

export async function readSandboxSubmission(
  directory: string,
  runId: string,
  leaseId: string,
  sessionId: string | null,
) {
  const file = Bun.file(join(bindingDirectory(directory), "submission.json"))
  if (!(await file.exists())) return null
  const saved = Schema.decodeUnknownSync(Submission)(await file.json(), {
    onExcessProperty: "error",
  })
  const binding = await readSandboxBinding(directory)
  if (
    binding.runId !== runId ||
    binding.leaseId !== leaseId ||
    binding.sessionId !== sessionId ||
    JSON.stringify({ ...binding, state: "active" }) !== JSON.stringify(saved.binding)
  )
    throw new Error("Sandbox result submission binding mismatch")
  return saved.completion
}
