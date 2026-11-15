/**
 * The texts and the paths of a sealed result, with the one result that both the seal
 * (deploy/sandbox/result.py) and the daemon's check (src/kernel/sealed-result.ts)
 * must give. The tests of each read this table, so a rule that changes on one side
 * only fails a test.
 *
 * The seal refuses more paths than the daemon on purpose (any component that starts
 * with `.git`, a path below deploy/sandbox, a name that is not NFC); those rules are
 * the seal's own and are not here. The daemon refuses a first path
 * component with `~` or `:`, which the seal accepts; that rule is not here either.
 */
export type SealedTextField = "title" | "commitMessage" | "body" | "finalMessage" | "path"

export type SealedTextCase = {
  readonly field: SealedTextField
  /** The text, or the path as UTF-8 when `pathHex` is absent. */
  readonly value: string
  /** The bytes of a path that is not UTF-8, in hex. */
  readonly pathHex?: string
  readonly accepted: boolean
}

const cases = (
  field: SealedTextField,
  accepted: boolean,
  values: ReadonlyArray<string>,
): ReadonlyArray<SealedTextCase> => values.map((value) => ({ field, value, accepted }))

const codePoints = (first: number, last: number) =>
  Array.from({ length: last - first + 1 }, (_, index) => String.fromCodePoint(first + index))

/** The controls of the C0 set but NUL, which no path or JSON key of a run can hold. */
export const c0Controls = codePoints(0x01, 0x1f)
export const c1Controls = codePoints(0x80, 0x9f)
export const bidiControls = [
  "\u061c",
  "\u200e",
  "\u200f",
  ...codePoints(0x202a, 0x202e),
  ...codePoints(0x2066, 0x2069),
]

/**
 * Characters by which a value of a run could change what a reader of a refusal, a log
 * line or a pushed result sees: C0 and C1 controls (CSI and NEL among them), DEL, the
 * bidi controls, the line and paragraph separators and the byte order mark.
 */
export const hostileCharacters: ReadonlyArray<string> = [
  ...c0Controls,
  "\u007f",
  ...c1Controls,
  ...bidiControls,
  "\u2028",
  "\u2029",
  "\ufeff",
]

/** The values of a run that a refusal must show as printable ASCII of a bounded length. */
export const hostileValues: ReadonlyArray<string> = [
  ...hostileCharacters.map((character) => `a${character}b`),
  "lone \ud800 surrogate",
  `${"x".repeat(5000)}\u009b2J`,
]

/** A path in a directory whose name holds a character, so the rule reads each component. */
const hostilePath = (character: string) => `src/a${character}b.txt`

export const sealedTextCases: ReadonlyArray<SealedTextCase> = [
  ...cases("title", true, ["Add the result file", "x".repeat(200), "雪".repeat(200)]),
  ...cases("title", false, hostileValues),
  ...cases("title", false, [
    "",
    "x".repeat(201),
    "雪".repeat(201),
    "line\nbreak",
    "tab\there",
    "bell\u0007",
    "delete\u007f",
    "next line\u0085",
    "zero​width",
    "line separator",
    "fixes #1",
    "mention @someone",
  ]),
  ...cases("commitMessage", true, [
    "Add the result file\n\nThe run wrote one file.\n",
    "Title 雪\n\n```sh\necho value\n```\n",
    "雪".repeat(3413),
  ]),
  ...cases("commitMessage", false, [
    "雪".repeat(3414),
    "title \u001b[31mred\n",
    "carriage\r\nreturn\n",
    "tab\there\n",
    "delete\u007f\n",
    "zero​width\n",
    "mention @someone\n",
    "back\\slash\n",
    "<details>\n",
    "closes #2\n",
  ]),
  ...cases("body", true, ["## Result\n\nOne file.", "x".repeat(32 * 1024)]),
  ...cases("body", false, [
    "",
    "   \n",
    "x".repeat(32 * 1024 + 1),
    "tab\there",
    "carriage\r\nreturn",
    "next line\u0085",
    "zero​width",
    "<details>",
    "&#64;user",
  ]),
  ...cases("finalMessage", true, [
    "",
    "Done: one file added.",
    "lines\nand\ttabs",
    "line separator",
    "mention @someone <b>",
    "x".repeat(64 * 1024),
  ]),
  ...cases("finalMessage", false, [
    "x".repeat(64 * 1024 + 1),
    "bell\u0007",
    "carriage\r\nreturn",
    "delete\u007f",
    "next line\u0085",
    "soft­hyphen",
    "zero​width",
    "tag\u{e0001}",
    "lone \ud800 surrogate",
  ]),
  ...cases("path", true, ["notes.md", "src/a.txt", "docs/café.md", "src/雪.txt"]),
  ...cases("path", false, [
    "line\nbreak.txt",
    "tab\there.txt",
    "src/escape\u001b.txt",
    "delete\u007f.txt",
    "next\u0085line.txt",
    ".github/workflows/x.yml",
    ".GitHub/workflows/x.yml",
    ".github\\workflows/x.yml",
  ]),
  ...cases(
    "path",
    false,
    [...c0Controls, "\u007f", ...c1Controls].map((character) => hostilePath(character)),
  ),
  ...cases("path", false, [`src/\u009b2J${"x".repeat(3000)}.txt`]),
  // What a reviewer of the pushed result reads differently: a bidi control, a line or
  // paragraph separator, a byte order mark, or a backslash in any component.
  ...cases("path", false, [
    ...[...bidiControls, "\u2028", "\u2029", "\ufeff"].map((character) => hostilePath(character)),
    "src/a\\b.txt",
    "x/..\\.github\\workflows\\y.yml",
  ]),
  // A joiner is no such character: a name with an emoji sequence holds it.
  ...cases("path", true, ["docs/\u{1f469}\u200d\u{1f4bb}.md"]),
  {
    field: "path",
    value: "not UTF-8 (an encoded surrogate)",
    pathHex: "7372632feda0802e747874",
    accepted: false,
  },
  {
    field: "path",
    value: "not UTF-8 (an overlong /)",
    pathHex: "7372632fc0af2e747874",
    accepted: false,
  },
  {
    field: "path",
    value: "not UTF-8 (above U+10FFFF)",
    pathHex: "7372632ff49080802e747874",
    accepted: false,
  },
  { field: "path", value: "not UTF-8 (0xff)", pathHex: "6e6f74ff2e747874", accepted: false },
  {
    field: "path",
    value: "not UTF-8 (a cut sequence)",
    pathHex: "7372632fe9e92e747874",
    accepted: false,
  },
]

/** The bytes of the path of a case. */
export const pathBytes = (item: SealedTextCase) =>
  item.pathHex === undefined ? Buffer.from(item.value) : Buffer.from(item.pathHex, "hex")
