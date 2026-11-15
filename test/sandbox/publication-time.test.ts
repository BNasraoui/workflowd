import { expect, test } from "bun:test"

/** The length of each text: 256 Ki characters. */
const length = 262144

/** A text of `length` characters: `head`, then `fill` repeated, then `tail`. */
const sized = (head: string, fill: string, tail = "") =>
  head + fill.repeat((length - head.length - tail.length) / fill.length) + tail

const listItem = ["a list item whose marker is followed by spaces", sized("1.", " ", "x")] as const
const closingKeywords = [
  "a closing keyword before each of many github.com paths",
  sized("", "fix:github.com/."),
] as const
/** Python's `.` takes a line separator, so only the Node check reads this run with backtracking. */
const backticks = [
  "a run of backticks that ends in a line separator",
  sized("", "`", String.fromCharCode(0x2028)),
] as const

/** The publication check of the publisher (Node) and of the result step (Python), with its texts. */
const checks = {
  node: [
    [listItem, closingKeywords, backticks],
    "node",
    "--input-type=module",
    "-e",
    `import { readFileSync } from "node:fs"
import { safePublication } from "./deploy/sandbox/publication.mjs"
console.log(JSON.stringify(safePublication(readFileSync(0, "utf8"))))`,
  ],
  python: [
    [listItem, closingKeywords],
    "python3",
    "-B",
    "-c",
    `import importlib.util, sys
spec = importlib.util.spec_from_file_location("result", "deploy/sandbox/result.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
try:
    m.safe_publication(sys.stdin.read())
    print("true")
except ValueError:
    print("false")`,
  ],
} as const

/** The answer of `check` for `text`, or "late" when it has none within `bound` milliseconds. */
async function judged(check: ReadonlyArray<string>, text: string, bound: number) {
  const child = Bun.spawn([...check], { stdin: new Blob([text]), stdout: "pipe", stderr: "pipe" })
  const late = setTimeout(() => child.kill("SIGKILL"), bound)
  try {
    const [status, out] = await Promise.all([child.exited, new Response(child.stdout).text()])
    return status === 0 ? out.trim() : "late"
  } finally {
    clearTimeout(late)
  }
}

for (const [runtime, [texts, ...check]] of Object.entries(checks))
  for (const [name, text] of texts)
    test(`[${runtime}] a publication text of 256 Ki characters that is ${name} is judged within 2 s`, async () => {
      expect(text.length).toBe(length)
      expect(await judged(check, text, 2000)).toBe("true")
    }, 10000)
