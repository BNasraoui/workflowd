import casefold from "./casefold.json" with { type: "json" }
import unicode from "./publication-unicode.json" with { type: "json" }

// Runtime normalization is stable for assigned Unicode 15.0 characters. Reject
// newer assignments first; all other Unicode properties and folding are pinned.
// See scripts/generate-publication-unicode.py and the shared runtime corpus.
if (unicode.version !== "15.0.0" || !unicode.javascript[process.versions.unicode]?.includes(process.versions.icu?.split(".")[0]))
  throw new Error("Unsupported publication Unicode runtime")
const fold = value => [...value.normalize("NFKC")].map(c => casefold[c] ?? c).join("")
// Each class tests one code point at a time: the engine of Bun 1.3 reads a code unit in
// U+F800–U+FBFF and the next in U+FC00–U+FFFF as one pair, so a class tested on a whole text
// misses the second of them.
const mark = new RegExp(`^[${unicode.marks}]$`, "u")
const stackedMarks = value => {
  let run = 0
  for (const character of value) if ((run = mark.test(character) ? run + 1 : 0) === 3) return true
  return false
}
const languages = new Set(["", "text", "diff", "ts", "typescript", "tsx", "js", "json", "sh", "bash", "python", "rust", "go", "sql", "yaml", "toml"])
const invisible = new RegExp(`^[${unicode.forbidden}]$`, "u")
const holdsInvisible = value => [...value].some(character => character !== "\n" && invisible.test(character))
const references = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/u
const keyword = String.raw`(?<![${unicode.letters}])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?::\s*|\s+)`
const closing = new RegExp(String.raw`${keyword}(?:#[0-9]|gh-[0-9]|[a-z0-9_.-]+\/[a-z0-9_.-]+#|https?:\/\/)`, "u")
const githubClosing = new RegExp(String.raw`${keyword}github\.com\/`, "gu")

/**
 * Whether a closing keyword names a github.com path that holds `/issues/` or `/pull/` before the
 * next white space. One pass: a later keyword reuses the searches of the one before it.
 */
function closesGithubPath(text) {
  const space = /\s/g
  const path = /\/(?:issues|pull)\//g
  let spaceAt = -1
  let pathAt = -1
  for (const match of text.matchAll(githubClosing)) {
    const end = match.index + match[0].length
    if (spaceAt < end) {
      space.lastIndex = end
      spaceAt = space.exec(text)?.index ?? text.length
    }
    if (pathAt < end) {
      path.lastIndex = end
      pathAt = path.exec(text)?.index ?? text.length
    }
    if (pathAt < spaceAt) return true
  }
  return false
}

/** Validate literal Markdown; return false on every ambiguous fence. */
export function safePublication(value, message = false) {
  if (!value.isWellFormed() || holdsInvisible(value) || references.test(value)) return false
  if (stackedMarks(value.normalize("NFD"))) return false
  const folded = fold(value)
  if (message && (/[<@$\\]/.test(value) || folded.includes("\\"))) return false
  // Check both concatenated emphasis and punctuation acting as a separator.
  for (const separator of ["", " "]) {
    const text = folded.replace(/[*_~`[\]()]/g, separator)
    if (closing.test(text) || closesGithubPath(text)) return false
  }
  let fence = null
  let blank = true
  for (const line of value.split("\n")) {
    if (/^ +(?:`{3,}|~{3,})/.test(line)) return false
    if (fence !== null) {
      if (line === fence) fence = null
      else if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) return false
    } else {
      if (line.includes("]:")) return false
      if (/^ {0,3}(?:>|(?:[-+*]|[0-9]+[.)]) ).*(?:`{3}|~{3})/.test(line)) return false
      const opener = /^(`{3,}(?!`)|~{3,}(?!~))(.*)$/.exec(line)
      if (opener !== null) {
        if (!blank || !languages.has(opener[2])) return false
        fence = opener[1]
      } else if (/[<@$\\]/.test(line) || fold(line).includes("\\")) return false
    }
    blank = /^ *$/.test(line)
  }
  return fence === null
}
