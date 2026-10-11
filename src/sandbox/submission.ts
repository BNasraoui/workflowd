import { dirname, join } from "node:path"
import { Schema } from "effect"
import { Database } from "bun:sqlite"
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
    "Finish your task by submitting the exact result environment ID and the branch name, PR title and squash commit message you choose. Only the first valid submission is accepted.",
  inputSchema: Schema.decodeUnknownSync(Schema.Json)(
    Schema.toJsonSchemaDocument(SandboxCompletion).schema,
  ),
}

const rejected = (text: string) => ({ isError: true, content: [{ type: "text", text }] })

async function checkBranch(binding: SandboxSessionBinding, branch: string) {
  const check = binding.submissionCheck
  if (check === undefined || check.databasePath === "")
    throw new Error("Submission lookup is unavailable")
  // The bridge receives only lookup metadata. Neither this GET nor SQLite has write authority.
  using database = new Database(check.databasePath, { readonly: true })
  const pending = () =>
    database
      .query(
        `SELECT 1 FROM sandbox_publications p
    JOIN sandbox_leases l ON l.run_id=p.run_id
    WHERE json_extract(l.policy,'$.repositoryId')=? AND json_extract(p.metadata,'$.branch')=?
      AND p.phase IN ('sealed','approving','approved') LIMIT 1`,
      )
      .get(binding.repositoryId, branch) !== null
  if (pending())
    return "That branch name is taken by a pending publication; choose another and call submit_result again."
  const response = await fetch(
    `${check.repositoryUrl}/git/ref/heads/${encodeURIComponent(branch)}`,
    {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10000),
    },
  )
  await response.body?.cancel()
  if (response.status === 200)
    return "That branch name is taken in the target repository; choose another and call submit_result again."
  if (response.status !== 404) throw new Error("Branch lookup failed")
  return pending()
    ? "That branch name is taken by a pending publication; choose another and call submit_result again."
    : null
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
          text: "submit_result requires exactly {environmentId: non-empty string, branch: string, title: non-empty single-line plain text (200 characters), commitMessage: non-empty plain text (10 KiB UTF-8; newlines only)}",
        },
      ],
    }
  if (await Bun.file(join(dirname(file), "submission.json")).exists())
    return rejected("Result already submitted for this binding; the first valid submission wins.")
  try {
    const problem = await checkBranch(binding, decoded.value.branch)
    if (problem !== null) return rejected(problem)
  } catch {
    return rejected(
      "Could not verify branch availability; retry submit_result after the lookup is available.",
    )
  }
  await assertBridgeBinding(file, transport)
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
