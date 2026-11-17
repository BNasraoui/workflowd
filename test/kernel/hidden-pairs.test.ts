import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { Effect, Exit } from "effect"
import { pathRefusal } from "../../deploy/sandbox/result-rules.mjs"
import { decodeSealedResult, isAgentCommitMessage } from "../../src/kernel/sealed-result"

/**
 * The daemon's hidden-character rules on the engine of the pinned Bun: a code unit in
 * U+F800–U+FBFF before one in U+FC00–U+FFFF must not hide the second from a rule. Each hidden code
 * point of the Basic Multilingual Plane follows each such lead in a path, a commit message and a
 * final message, and each rule refuses each of them.
 */

/** The code points of the Basic Multilingual Plane that the seal (result.py `invisible`) hides. */
const hidden: ReadonlyArray<number> = JSON.parse(
  spawnSync(
    "python3",
    [
      "-I",
      "-c",
      "import importlib.util, json, sys\nspec = importlib.util.spec_from_file_location('result', sys.argv[1])\nm = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\nprint(json.dumps([c for c in range(0x10000) if not 0xd800 <= c <= 0xdfff and m.invisible(chr(c))]))",
      resolve("deploy/sandbox/result.py"),
    ],
    { encoding: "utf8" },
  ).stdout,
)

const leads = Array.from({ length: 0x400 }, (_, index) => String.fromCharCode(0xf800 + index))

/** Each pair of a lead and a hidden code point that `admitted` lets pass, as `U+lead U+hidden`. */
const admittedPairs = (admitted: (pair: string) => boolean) => {
  const pairs: string[] = []
  for (const lead of leads)
    for (const code of hidden) {
      const pair = lead + String.fromCharCode(code)
      if (admitted(pair))
        pairs.push(`U+${lead.charCodeAt(0).toString(16)} U+${code.toString(16).padStart(4, "0")}`)
    }
  return pairs
}

test("the seal hides each code point that the report names after a lead", () => {
  for (const code of [0xfe00, 0xfe0f, 0xfeff, 0xffa0, 0xfff0, 0xfffb])
    expect(hidden).toContain(code)
})

test("the daemon refuses a path with each hidden code point after each lead", () => {
  expect(admittedPairs((pair) => pathRefusal(`src/a${pair}b.txt`) === undefined)).toEqual([])
})

test("the daemon refuses a commit message with each hidden code point after each lead", () => {
  expect(admittedPairs((pair) => isAgentCommitMessage(`Fix a${pair}b\n`))).toEqual([])
})

test("the daemon refuses a final message with each hidden code point after each lead", () => {
  const manifest = (finalMessage: string) =>
    new TextEncoder().encode(
      JSON.stringify({
        sourceSha: "a".repeat(40),
        title: "Title",
        body: "Body",
        finalMessage,
      }),
    )
  expect(
    admittedPairs((pair) =>
      Exit.isSuccess(
        Effect.runSyncExit(decodeSealedResult(manifest(`a${pair}b`), new Uint8Array())),
      ),
    ),
  ).toEqual([])
})
