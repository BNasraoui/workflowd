/**
 * The texts, the paths and the changes of a sealed result, with the one result that both the seal
 * (deploy/sandbox/result.py) and the daemon's check (src/kernel/sealed-result.ts) must give. The
 * tests of each run every case of these tables, so a rule that changes on one side only fails a
 * test: what the seal refuses the check refuses, and what the seal accepts the check accepts.
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

/**
 * Code points that a reader cannot see and that are not controls: the joiners, the
 * word joiner and the invisible operators, U+180E, the soft hyphen, the interlinear
 * annotation marks, each variation selector of the first block and the ends of the
 * second, the tags, the Hangul fillers, U+034F, U+17B4, U+17B5, the Mongolian free
 * variation selectors and reserved default-ignorable code points.
 */
export const invisibleCharacters: ReadonlyArray<string> = [
  "\u200b",
  "\u200c",
  "\u200d",
  ...codePoints(0x2060, 0x2064),
  "\u180e",
  "\u00ad",
  ...codePoints(0xfff9, 0xfffb),
  ...codePoints(0xfe00, 0xfe0f),
  "\u{e0100}",
  "\u{e01ef}",
  "\u{e0001}",
  "\u{e0020}",
  "\u{e007f}",
  "\u034f",
  "\u115f",
  "\u1160",
  "\u17b4",
  "\u17b5",
  ...codePoints(0x180b, 0x180d),
  "\u180f",
  "\u3164",
  "\uffa0",
  "\u2065",
  "\ufff0",
  "\u{e0000}",
  "\u{e0fff}",
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
  // A code point that a reader cannot see: a format character or a default-ignorable
  // code point, in a path as in a text. A file name with an emoji sequence that needs a
  // joiner or a variation selector is refused; an emoji of one code point is not. A path
  // holds no U+FE0F: `src/a\ufe0fb.txt` reads as `src/ab.txt` and is another path.
  ...cases("path", false, [
    "src/in\u200bdex.ts",
    "src/in\u200ddex.ts",
    "docs/\u{1f469}\u200d\u{1f4bb}.md",
    "docs/\u2714\ufe0f.md",
    ...invisibleCharacters.map(hostilePath),
  ]),
  ...cases("path", true, ["docs/\u{1f680}.md", "docs/\u2714.md"]),
  ...cases(
    "finalMessage",
    false,
    invisibleCharacters.map((character) => `a${character}b`),
  ),
  // U+FE0F where it selects the emoji form: directly after a code point with the Emoji
  // property that is not ASCII. After a letter, a digit, `#`, a space, a joiner, another
  // U+FE0F or at the start it is an invisible code point.
  ...cases("commitMessage", true, ["Fix the \u2714\ufe0f marks\n", "Ship it \u{1f680}\ufe0f\n"]),
  ...cases("commitMessage", false, [
    "\ufe0f first\n",
    "a letter a\ufe0f\n",
    "a digit 1\ufe0f\n",
    "a sign #\ufe0f\n",
    "two \u2714\ufe0f\ufe0f\n",
    "after a space \ufe0f\n",
    "after a line\n\ufe0f\n",
    "after a joiner \u{1f469}\u200d\ufe0f\n",
  ]),
  ...cases("finalMessage", true, ["Done \u2714\ufe0f", "\u2764\ufe0f\ttab"]),
  ...cases("finalMessage", false, [
    "\ufe0f",
    "\ufe0f first",
    "a letter a\ufe0f",
    "a digit 1\ufe0f",
    "a star *\ufe0f",
    "two \u2714\ufe0f\ufe0f",
    "tab\t\ufe0f",
  ]),
  // The names that the seal protects, in any directory: each component that starts with `.git`
  // (attributes, submodules, ignore rules, workflows), the runner's own tooling, and a first
  // component that a checkout on Windows reads as another name (a short name or a stream).
  ...cases("path", false, [
    ".gitattributes",
    ".gitmodules",
    ".gitignore",
    "src/.gitignore",
    ".GITATTRIBUTES",
    "sub/.github/workflows/x.yml",
    "deploy/sandbox/runner.sh",
    "Deploy/Sandbox/runner.sh",
    "deploy/sandbox",
    "notes~1/x.txt",
    "GITHUB~1/workflows/x.yml",
    "a:b.txt",
  ]),
  // Names that read as another name or as blank: a component that ends with a space or a dot, a
  // space other than U+0020, the blank Braille pattern, and a name that NFKC changes (a ligature,
  // a compatibility form, a decomposed letter).
  ...cases("path", false, [
    "notes /x.txt",
    "notes./x.txt",
    "x.txt ",
    "x.txt\u00a0",
    "a\u3000b.txt",
    "\u2800.txt",
    "notes/\u2800",
    "con\ufb01g",
    "\uff41.txt",
    "docs/cafe\u0301.md",
  ]),
  ...cases("path", false, [`ghp_${"A".repeat(36)}.txt`]),
  // A hidden code point after a code unit in U+F800–U+FBFF, which the engine of Bun 1.3 reads as
  // one pair with it when a class tests a whole text.
  ...cases("path", false, ["src/a\uf8ff\ufe0fb.txt", "src/a\uf8ff\uffa0b.txt"]),
  ...cases("commitMessage", false, ["Fix a\uf8ff\ufeffb\n", "Fix a\ufb01\ufe0fb\n"]),
  ...cases("finalMessage", false, ["a\uf8ff\ufe00b", "a\ufb01\ufeffb", "a\uf8ff\ufffbb"]),
  ...cases("finalMessage", true, ["private \uf8ff use"]),
  ...cases("path", true, [
    "docs/a b.md",
    "src/.eslintrc.json",
    "notes/x~1.txt",
    "notes/a:b.txt",
    "docs/na\u00efve.md",
    ".well-known/x.txt",
  ]),
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

/** A file of a change: its text, executable or not; null removes the path. */
export type ChangeFile = string | { readonly text: string; readonly executable: boolean } | null

/** Text in the shape of a GitHub token, as a tracked test fixture may hold it. */
export const credentialText = `token = "ghp_${"A".repeat(36)}"\n`

/**
 * The source tree of each case of `sealedChangeCases`, beside the README.md and the executable
 * run.sh of the fixture: a name in NFD, two names that differ by case, credential-shaped text and
 * ignore rules, all tracked and all left as they are unless a case changes them.
 */
export const changeBase: Readonly<Record<string, string>> = {
  "docs/cafe\u0301.md": "decomposed\n",
  "notes/Twin.md": "one\n",
  "notes/twin.md": "two\n",
  "fixture.txt": credentialText,
  ".gitignore": "build/\n",
}

export type SealedChangeCase = {
  readonly name: string
  /** The one commit of the change on `changeBase`: each path and its new file. */
  readonly change: Readonly<Record<string, ChangeFile>>
  readonly accepted: boolean
}

const mebibyte = "a".repeat(1024 * 1024)

/** Changes of one commit, with the result that both the seal and the check must give. */
export const sealedChangeCases: ReadonlyArray<SealedChangeCase> = [
  { name: "a new file", change: { "docs/new.md": "new\n" }, accepted: true },
  {
    name: "a change beside tracked twins, a tracked NFD name and tracked credential-shaped text",
    change: { "README.md": "changed\n" },
    accepted: true,
  },
  { name: "a removed file", change: { "README.md": null }, accepted: true },
  { name: "a file of the bound of a blob", change: { "big.txt": mebibyte }, accepted: true },
  {
    name: "a name in NFC beside its tracked NFD twin",
    change: { "docs/caf\u00e9.md": "composed\n" },
    accepted: false,
  },
  {
    name: "a name in NFD beside the same name in NFC",
    change: { "docs/x\u00e9.md": "composed\n", "docs/xe\u0301.md": "decomposed\n" },
    accepted: false,
  },
  { name: "readme.md beside README.md", change: { "readme.md": "lower\n" }, accepted: false },
  {
    name: "a change of one of two tracked twins",
    change: { "notes/twin.md": "changed\n" },
    accepted: false,
  },
  { name: ".gitattributes", change: { ".gitattributes": "*.md binary\n" }, accepted: false },
  { name: ".gitmodules", change: { ".gitmodules": "[submodule]\n" }, accepted: false },
  { name: "a changed .gitignore", change: { ".gitignore": "build/\nout/\n" }, accepted: false },
  { name: "a removed .gitignore", change: { ".gitignore": null }, accepted: false },
  {
    name: "the runner's own tooling",
    change: { "deploy/sandbox/runner.sh": "#!/bin/sh\n" },
    accepted: false,
  },
  {
    name: "a nested workflow",
    change: { "sub/.github/workflows/x.yml": "on: push\n" },
    accepted: false,
  },
  { name: "credential-shaped text", change: { "token.txt": credentialText }, accepted: false },
  {
    name: "a copy of the tracked credential-shaped fixture",
    change: { "copy.txt": credentialText },
    accepted: false,
  },
  {
    name: "credential-shaped text split by white space",
    change: { "split.txt": `ghp_${"B".repeat(8)}\n  ${"B".repeat(30)}\n` },
    accepted: false,
  },
  { name: "a short name", change: { "notes~1/x.txt": "x\n" }, accepted: false },
  { name: "a stream name", change: { "a:b.txt": "x\n" }, accepted: false },
  { name: "a trailing space", change: { "notes /x.txt": "x\n" }, accepted: false },
  { name: "a trailing no-break space", change: { "x.txt\u00a0": "x\n" }, accepted: false },
  { name: "the blank Braille pattern", change: { "\u2800.txt": "x\n" }, accepted: false },
  { name: "config written with U+FB01", change: { "con\ufb01g": "x\n" }, accepted: false },
  {
    name: "a new executable file",
    change: { "tool.sh": { text: "#!/bin/sh\n", executable: true } },
    accepted: false,
  },
  {
    name: "a mode change",
    change: { "run.sh": { text: "#!/bin/sh\n", executable: false } },
    accepted: false,
  },
  {
    name: "a file over the bound of a blob",
    change: { "big.txt": `${mebibyte}b` },
    accepted: false,
  },
  {
    name: "more than the bound of all changed files",
    change: Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [`big/${index}.txt`, `${index}${mebibyte.slice(1)}`]),
    ),
    accepted: false,
  },
]
