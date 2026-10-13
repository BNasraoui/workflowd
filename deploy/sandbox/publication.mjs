import casefold from "./casefold.json" with { type: "json" }
import unicode from "./publication-unicode.json" with { type: "json" }

// Runtime normalization is stable for assigned Unicode 15.0 characters. Reject
// newer assignments first; all other Unicode properties and folding are pinned.
// See scripts/generate-publication-unicode.py and the shared runtime corpus.
if (unicode.version !== "15.0.0" || !unicode.javascript[process.versions.unicode]?.includes(process.versions.icu?.split(".")[0]))
  throw new Error("Unsupported publication Unicode runtime")
const fold = value => [...value.normalize("NFKC")].map(c => casefold[c] ?? c).join("")
const stackedMarks = new RegExp(`[${unicode.marks}]{3}`, "u")
const languages = new Set(["", "text", "diff", "ts", "typescript", "tsx", "js", "json", "sh", "bash", "python", "rust", "go", "sql", "yaml", "toml"])
const invisible = new RegExp(`[${unicode.forbidden}]`, "u")
const references = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/u
const closing = new RegExp(String.raw`(?:^|[^${unicode.letters}])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?::\s*|\s+)(?:#[0-9]|gh-[0-9]|[a-z0-9_.-]+\/[a-z0-9_.-]+#|https?:\/\/|github\.com\/[^\s]*\/(?:issues|pull)\/)`, "u")

/** Validate literal Markdown; return false on every ambiguous fence. */
export function safePublication(value, message = false) {
  if (!value.isWellFormed() || invisible.test(value.replaceAll("\n", "")) || references.test(value)) return false
  if (stackedMarks.test(value.normalize("NFD"))) return false
  const folded = fold(value)
  if (message && (/[<@$\\]/.test(value) || folded.includes("\\"))) return false
  // Check both concatenated emphasis and punctuation acting as a separator.
  if (["", " "].some(separator => closing.test(folded.replace(/[*_~`[\]()]/g, separator)))) return false
  let fence = null
  let blank = true
  for (const line of value.split("\n")) {
    if (/^ +(?:`{3,}|~{3,})/.test(line)) return false
    if (fence !== null) {
      if (line === fence) fence = null
      else if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) return false
    } else {
      if (line.includes("]:")) return false
      if (/^ {0,3}(?:> ?|(?:[-+*]|[0-9]+[.)]) +).*(?:`{3,}|~{3,})/.test(line)) return false
      const opener = /^(`{3,}|~{3,})(.*)$/.exec(line)
      if (opener !== null) {
        if (!blank || !languages.has(opener[2])) return false
        fence = opener[1]
      } else if (/[<@$\\]/.test(line) || fold(line).includes("\\")) return false
    }
    blank = /^ *$/.test(line)
  }
  return fence === null
}
