/**
 * The rules of a runner run's result: the bounds that the seal (result.py RESULT_BOUNDS) and the
 * daemon's check (src/kernel/sealed-result.ts) hold, and the same rules in plain words for the
 * agent, which the harness gives Claude Code. A test compares these bounds with the seal's, and
 * the shared table of cases (test/kernel/sealed-text-cases.ts) runs each rule on both sides.
 */

import casefold from "./casefold.json" with { type: "json" }
import { isInvisible } from "./hidden-text.mjs"

const MiB = 1024 * 1024

/** The bounds of one result's change. */
export const resultBounds = {
  /** The bytes of one added or changed file. */
  blobBytes: MiB,
  /** The bytes of all added or changed files together. */
  changedBytes: 8 * MiB,
  /** The paths that the change adds, changes or removes. */
  changedPaths: 100,
  commits: 100,
  objects: 10_000,
  objectBytes: 64 * MiB,
}

const control = /^\p{Cc}$/u
const spaceSeparator = /^\p{Zs}$/u

/**
 * Whether a code point of a path is refused: a control character, a backslash, an invisible code
 * point (hidden-text.mjs), a line or paragraph separator, a space separator other than U+0020, or
 * the blank Braille pattern U+2800. Each code point is tested alone.
 */
const refusedInPath = (character) =>
  character === "\\" ||
  character === "\u2028" ||
  character === "\u2029" ||
  character === "\u2800" ||
  control.test(character) ||
  isInvisible(character) ||
  (character !== " " && spaceSeparator.test(character))

/** Whether a path component starts with `.git` in either case, as `.gitignore` or `.GitHub`. */
const isGitName = (component) =>
  component.toLowerCase().startsWith(".git") || component.toUpperCase().startsWith(".GIT")

/**
 * The rule that a path of a change breaks, as the seal holds it (result.py safe_path), or
 * undefined: `path_name` for a refused code point, a name that NFKC changes, or an empty, `.`,
 * `..` or component that ends with a space or a dot; `github_path` for a first component with `~`
 * (a short name such as GITHUB~1) or `:` (a stream); `protected_path` for a component that starts
 * with `.git` (`.github`, `.gitattributes`, `.gitmodules`, `.gitignore` in any directory) or a
 * path below deploy/sandbox, the runner's own tooling.
 */
export const pathRefusal = (path) => {
  for (const character of path) if (refusedInPath(character)) return "path_name"
  if (path.normalize("NFKC") !== path) return "path_name"
  const parts = path.split("/")
  if (parts.some((part) => part === "" || part === "." || part === ".." || /[ .]$/.test(part)))
    return "path_name"
  if (/[~:]/.test(parts[0])) return "github_path"
  if (parts.some(isGitName)) return "protected_path"
  const lower = path.toLowerCase()
  if (lower === "deploy/sandbox" || lower.startsWith("deploy/sandbox/")) return "protected_path"
  return undefined
}

/**
 * The key under which two paths are one path to a checkout on macOS or Windows: the path in NFC,
 * full case folded (casefold.json, Python's str.casefold of the seal).
 */
export const pathKey = (path) => {
  let key = ""
  for (const character of path.normalize("NFC")) key += casefold[character] ?? character
  return key
}

const credential =
  /(?:gh[pousr]_|github_pat_|sk-ant-)[A-Za-z0-9_-]{16,}|-----BEGIN(?:RSA|EC|OPENSSH)?PRIVATEKEY-----/

/**
 * Whether `bytes` hold text in the shape of a credential, also when white space splits it: a GitHub
 * token, an Anthropic key or a private key header (result.py content_check).
 */
export const credentialShaped = (bytes) =>
  credential.test(Buffer.from(bytes).toString("latin1").replace(/[ \t\n\r\f\v]+/g, ""))

const mib = (bytes) => `${bytes / MiB} MiB`

/** What a result may hold, in plain words: the text that the harness adds to the agent's prompt. */
export const resultRules = `How the result of this run is taken:
- When you end, the work tree of /workdir is sealed as the run's result: each tracked file and each new file that Git does not ignore, judged against the commit that you started on. Commits that you make, branches and the .git directory are not read; leave the change in the work tree.
- Ignored files (dependencies, build output, caches) are left out, whatever their size or number.
- The result is refused, and the work of the run is lost, when the change does any of these:
  - adds or changes a symbolic link, a hard link or a special file;
  - adds an executable file, or changes the mode of a tracked file;
  - adds, changes or removes a path with a component that starts with ".git" (such as .gitignore, .gitattributes, .gitmodules or .github), a path below deploy/sandbox, or a path whose first component holds "~" or ":";
  - names a path with a control character, a backslash, an invisible or format character, a line or paragraph separator, a space other than the plain space, a component that ends with a space or a dot, a name that Unicode NFKC normalization changes, or a name that differs from another path of the tree only by case or normal form;
  - holds a file over ${mib(resultBounds.blobBytes)}, more than ${mib(resultBounds.changedBytes)} of added or changed files, or more than ${resultBounds.changedPaths} changed paths;
  - holds text in the shape of a credential (a GitHub token, an Anthropic key or a private key).
- Before your last answer, remove from the work tree what the result must not hold.`
