import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import {
  codexFailureLooksUnauthenticated,
  makeCodexCli,
  parseCodexExecEvent,
  type CodexExecEvent,
} from "../../src/kernel/codex-session"

/**
 * Event lines captured verbatim from real `codex exec --json` runs
 * (codex-cli 0.153.4, September 2026): a minimal success turn, a turn that
 * executed a shell command, and an unauthenticated turn (empty CODEX_HOME).
 */
const capturedSuccessTurn = [
  `{"type":"thread.started","thread_id":"01a09976-e799-7c52-9759-8b76d692b755"}`,
  `{"type":"turn.started"}`,
  `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"pong"}}`,
  `{"type":"turn.completed","usage":{"input_tokens":16672,"cached_input_tokens":12160,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}`,
]

const capturedCommandTurn = [
  `{"type":"thread.started","thread_id":"01a09977-5eb9-7cb3-b81e-401d9abe6139"}`,
  `{"type":"turn.started"}`,
  `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll run the requested shell command."}}`,
  `{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc 'echo fixture-probe'","aggregated_output":"","exit_code":null,"status":"in_progress"}}`,
  `{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc 'echo fixture-probe'","aggregated_output":"fixture-probe\\n","exit_code":0,"status":"completed"}}`,
  `{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"done"}}`,
  `{"type":"turn.completed","usage":{"input_tokens":31705,"cached_input_tokens":22272,"cache_write_input_tokens":0,"output_tokens":101,"reasoning_output_tokens":0}}`,
]

const capturedUnauthenticatedTurn = [
  `{"type":"thread.started","thread_id":"01a09977-a0ee-7262-b052-8ab64abec409"}`,
  `{"type":"turn.started"}`,
  `{"type":"error","message":"Reconnecting... 5/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses, cf-ray: a3a51d889dcfa7ad-SYD)"}`,
  `{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Falling back from WebSockets to HTTPS transport. unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses, cf-ray: a3a51d9dcce57824-BNE"}}`,
  `{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: a3a51dd47e8fd70c-BNE, request id: req_efe7cfbc1b674d88ba5ab3c31af88759"}}`,
]

const parseAll = (lines: ReadonlyArray<string>): ReadonlyArray<CodexExecEvent> =>
  lines.map(parseCodexExecEvent)

describe("codex exec JSONL parsing", () => {
  test("parses a captured success turn into thread, message, and usage events", () => {
    const [thread, turn, message, completed] = parseAll(capturedSuccessTurn)
    expect(thread).toEqual({
      type: "thread.started",
      threadId: "01a09976-e799-7c52-9759-8b76d692b755",
    })
    expect(turn).toEqual({ type: "turn.started" })
    expect(message).toEqual({ type: "agent_message", text: "pong" })
    expect(completed).toEqual({ type: "turn.completed", outputTokens: 5 })
  })

  test("ignores command-execution items and keeps every agent message", () => {
    const events = parseAll(capturedCommandTurn)
    const messages = events.filter((event) => event.type === "agent_message")
    expect(messages).toHaveLength(2)
    expect(messages[1]).toEqual({ type: "agent_message", text: "done" })
    expect(events.at(-1)).toEqual({ type: "turn.completed", outputTokens: 101 })
    expect(events.some((event) => event.type === "other")).toBe(true)
  })

  test("surfaces error events and the turn failure of a captured unauthenticated run", () => {
    const events = parseAll(capturedUnauthenticatedTurn)
    const errors = events.filter((event) => event.type === "error")
    expect(errors).toHaveLength(2)
    const failed = events.at(-1)
    expect(failed).toMatchObject({ type: "turn.failed" })
    if (failed?.type !== "turn.failed") throw new Error("unreachable")
    expect(failed.message).toContain("401 Unauthorized")
    expect(
      codexFailureLooksUnauthenticated([
        ...errors.map((error) => (error.type === "error" ? error.message : "")),
        failed.message,
      ]),
    ).toBe(true)
  })

  test("decodes malformed and unrecognized lines to other", () => {
    expect(parseCodexExecEvent("not json at all")).toEqual({ type: "other" })
    expect(parseCodexExecEvent(`{"type":"item.started","item":{"type":"reasoning"}}`)).toEqual({
      type: "other",
    })
    expect(parseCodexExecEvent(`{"type":"thread.started"}`)).toEqual({ type: "other" })
    expect(parseCodexExecEvent(`{"type":"turn.completed","usage":{}}`)).toEqual({
      type: "turn.completed",
      outputTokens: null,
    })
  })
})

describe("codex cli port", () => {
  test("preflight maps a missing binary and a failed login check to distinct kinds", async () => {
    const absent = makeCodexCli({
      binary: join(tmpdir(), "codex-does-not-exist"),
      custodyRoot: join(tmpdir(), "unused-codex-custody"),
    })
    const unusable = await Effect.runPromise(absent.preflight.pipe(Effect.result))
    expect(unusable._tag).toBe("Failure")
    if (unusable._tag === "Failure") {
      expect(unusable.failure.kind).toBe("cli_unusable")
    }

    const root = await mkdtemp(join(tmpdir(), "codex-fake-cli-"))
    try {
      const unauthenticated = join(root, "codex-unauthenticated")
      await writeFile(
        unauthenticated,
        "#!/bin/sh\ncase \"$1\" in\n  --version) echo 'codex-cli 0.153.4';;\n  login) case \"$2\" in status) echo 'Not logged in'; exit 1;; esac;;\nesac\n",
        { mode: 0o755 },
      )
      const cli = makeCodexCli({ binary: unauthenticated, custodyRoot: join(root, "custody") })
      const result = await Effect.runPromise(cli.preflight.pipe(Effect.result))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.kind).toBe("not_authenticated")
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("preflight accepts a fake cli with credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-fake-cli-"))
    try {
      const authenticated = join(root, "codex-ok")
      await writeFile(
        authenticated,
        "#!/bin/sh\ncase \"$1\" in\n  --version) echo 'codex-cli 0.153.4';;\n  login) echo 'Logged in using ChatGPT';;\nesac\n",
        { mode: 0o755 },
      )
      const cli = makeCodexCli({ binary: authenticated, custodyRoot: join(root, "custody") })
      const result = await Effect.runPromise(cli.preflight.pipe(Effect.result))
      expect(result._tag).toBe("Success")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
