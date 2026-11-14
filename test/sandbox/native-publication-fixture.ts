import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { captureNativeResult } from "../../deploy/sandbox/native-capture.mjs"
import { ResultMetadata } from "../../src/sandbox/publish-store"
import { command } from "./harness"

/** Native result captured from a stopped workspace export by the in-repo capture. */
export async function nativePublicationArtifact(
  root: string,
  sourceSha: string,
  completion: { branch: string; title: string; body: string; commitMessage: string },
) {
  const runner = join(root, "native-runner")
  const directory = join(runner, "native")
  const work = join(root, "workflowd-publish")
  const source = join(root, "source")
  const tooling = resolve("deploy/sandbox")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await mkdir(work, { recursive: true, mode: 0o700 })
  await command(["git", "clone", "--bare", source, join(directory, "source.git")])
  await writeFile(join(runner, "source.sha"), sourceSha)
  const invoke = async (cwd: string, args: string[], input = "") => {
    const child = Bun.spawn(args, { cwd, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" })
    const [code, output] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code !== 0) throw new Error("Native publication fixture validation failed")
    return output.trim()
  }
  const invocation = {
    nonce: "a".repeat(64),
    session: "11111111-1111-4111-8111-111111111111",
    state: "stopped",
    outcome: "completed",
  }
  const metadata = Schema.decodeUnknownSync(Schema.fromJsonString(ResultMetadata))(
    await captureNativeResult({
      root: runner,
      directory,
      tooling,
      invocation,
      request: { nonce: invocation.nonce, session: invocation.session, completion },
      backend: {
        async exportWorkspace() {
          await command([
            "tar",
            "--exclude=.git",
            "-cf",
            join(directory, "capture.tar"),
            "-C",
            source,
            ".",
          ])
        },
      },
      command: (args, input) => invoke(directory, args, input),
    }),
  )
  const archive = join(work, "result.zip")
  await command(
    [
      "python3",
      "-I",
      "-c",
      "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1], 'x'); z.write('result.json','result.json'); z.write('result.bundle','result.bundle'); z.close()",
      archive,
    ],
    join(runner, "result"),
  )
  const archiveDigest =
    "sha256:" +
    createHash("sha256")
      .update(await readFile(archive))
      .digest("hex")
  await invoke(
    work,
    ["python3", "-I", join(tooling, "result.py"), "validate", "file://" + source],
    JSON.stringify({
      source: sourceSha,
      result: metadata.resultSha,
      tree: metadata.treeSha,
      manifest: metadata.manifestSha256,
      digest: archiveDigest,
    }),
  )
  return {
    metadata,
    archiveDigest,
    rawManifest: await readFile(join(work, "validated/result.json"), "utf8"),
  }
}
