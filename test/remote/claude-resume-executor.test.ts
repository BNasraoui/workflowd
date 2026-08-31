import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ClaudeCliPort } from "../../src/kernel/claude-session"
import { encodeClaudeProjectDir, makeClaudeCli } from "../../src/kernel/claude-session"
import { WorkspaceError } from "../../src/workspace/errors"
import { makeClaudeResumeExecutor } from "../../src/remote/claude-resume-executor"
import type { ClaudeResumeJobV1 } from "../../src/remote/contract"
import { MAX_CLAUDE_RESUME_OUTPUT_BYTES } from "../../src/remote/contract"

const schema = JSON.stringify({
  type: "object",
  properties: { acknowledged: { type: "boolean" }, summary: { type: "string" } },
})

const payload = (over: Partial<ClaudeResumeJobV1> = {}): ClaudeResumeJobV1 => ({
  kind: "claude_resume",
  hostId: "ben-arch",
  nativeSessionId: "abc-123",
  directory: "/allowed/work",
  prompt: "wake up",
  extractionSchemaJson: schema,
  turnTimeoutMs: 120_000,
  ...over,
})

/** A scripted CLI whose resume returns the next queued envelope; each entry
 * is the `.result` text the CLI would print, or the sentinel "TIMEOUT". */
const scriptedCli = (
  turns: Array<string>,
  opts: { exists?: boolean; calls?: Array<string> } = {},
): ClaudeCliPort => ({
  sessionExists: () => Effect.succeed(opts.exists ?? true),
  resume: (input) => {
    opts.calls?.push(input.prompt)
    const next = turns.shift() ?? ""
    if (next === "TIMEOUT") {
      return Effect.fail(
        new WorkspaceError({
          operation: "wake claude session",
          cause: new Error("claude resume did not finish within 120000ms"),
        }),
      )
    }
    if (next === "RAW") return Effect.succeed("not a json envelope")
    return Effect.succeed(JSON.stringify({ result: next }))
  },
})

const run = (cli: ClaudeCliPort, p: ClaudeResumeJobV1, allowed = ["/allowed"]) =>
  Effect.runPromise(makeClaudeResumeExecutor({ cli, allowedDirectories: allowed }).execute(p))

describe("claude resume executor", () => {
  test("runs the wake then the extraction and returns the structured output", async () => {
    const calls: Array<string> = []
    const ack = JSON.stringify({ acknowledged: true, summary: "done" })
    const outcome = await run(scriptedCli(["ACK line", ack], { calls }), payload())
    expect(outcome).toEqual({ status: "succeeded", output: ack })
    // Two turns: the wake carries the prompt verbatim, then the extraction.
    expect(calls).toHaveLength(2)
    expect(calls[0]).toBe("wake up")
    expect(calls[1]).toContain("JSON Schema")
  })

  test("refuses a directory outside the allow-list, and an unset allow-list refuses all", async () => {
    const outside = await run(scriptedCli(["x", "y"]), payload({ directory: "/etc/secrets" }))
    expect(outside).toEqual({ status: "failed", failureReason: "directory_not_allowed" })
    const noneAllowed = await run(scriptedCli(["x", "y"]), payload(), [])
    expect(noneAllowed).toEqual({ status: "failed", failureReason: "directory_not_allowed" })
  })

  test("reports a missing transcript before running any turn", async () => {
    const calls: Array<string> = []
    const outcome = await run(scriptedCli([], { exists: false, calls }), payload())
    expect(outcome).toEqual({ status: "failed", failureReason: "transcript_missing" })
    expect(calls).toHaveLength(0)
  })

  test("maps a turn timeout to cli_timeout", async () => {
    const outcome = await run(scriptedCli(["TIMEOUT"]), payload())
    expect(outcome).toEqual({ status: "failed", failureReason: "cli_timeout" })
  })

  test("retries extraction once with feedback, recovering on the second answer", async () => {
    const calls: Array<string> = []
    const ack = JSON.stringify({ acknowledged: true, summary: "second" })
    const outcome = await run(scriptedCli(["ACK", "still prose", ack], { calls }), payload())
    expect(outcome).toEqual({ status: "succeeded", output: ack })
    expect(calls).toHaveLength(3)
    expect(calls[2]).toContain("failed validation")
  })

  test("gives up as output_unparseable after the retry also fails", async () => {
    const outcome = await run(scriptedCli(["ACK", "prose", "still prose"]), payload())
    expect(outcome).toEqual({ status: "failed", failureReason: "output_unparseable" })
  })

  test("rejects an oversized structured answer", async () => {
    const big = JSON.stringify({
      acknowledged: true,
      summary: "x".repeat(MAX_CLAUDE_RESUME_OUTPUT_BYTES),
    })
    const outcome = await run(scriptedCli(["ACK", big]), payload())
    expect(outcome).toEqual({ status: "failed", failureReason: "output_oversized" })
  })

  test("a non-envelope CLI reply is cli_failed", async () => {
    const outcome = await run(scriptedCli(["RAW"]), payload())
    expect(outcome).toEqual({ status: "failed", failureReason: "cli_failed" })
  })

  test("the live /bin/echo CLI proves the prompt rides stdin, not argv", async () => {
    const home = await mkdtemp(join(tmpdir(), "claude-exec-"))
    try {
      const dir = join(home, "work")
      await mkdir(join(home, ".claude", "projects", encodeClaudeProjectDir(dir)), {
        recursive: true,
      })
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(home, ".claude", "projects", encodeClaudeProjectDir(dir), "abc-123.jsonl"),
        "{}\n",
      )
      // /bin/echo prints its argv (never the stdin prompt) as the CLI's
      // stdout, which is not a JSON envelope — so the executor reports
      // cli_failed. The point is that it did not crash and the secret
      // prompt never reached the command line.
      const outcome = await run(
        makeClaudeCliLike(home),
        payload({ directory: dir, nativeSessionId: "abc-123", prompt: "secret; rm -rf $HOME" }),
        [home],
      )
      expect(outcome).toEqual({ status: "failed", failureReason: "cli_failed" })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

const makeClaudeCliLike = (home: string): ClaudeCliPort =>
  makeClaudeCli({ binary: "/bin/echo", home })
