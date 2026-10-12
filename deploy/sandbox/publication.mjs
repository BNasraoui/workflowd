import casefold from "./casefold.json" with { type: "json" }

// Full case folding differs from lowercase (e.g. sharp s and Cherokee).
// casefold.json: Unicode 15.0 full-fold exceptions to lowercase, generated with
// Python {chr(c): chr(c).casefold() for c in range(0x110000)
//         if chr(c).casefold() != chr(c).lower()}.
const fold = value => [...value.normalize("NFKC")].map(c => casefold[c] ?? c.toLowerCase()).join("")
const languages = new Set(["", "text", "diff", "ts", "typescript", "tsx", "js", "json", "sh", "bash", "python", "rust", "go", "sql", "yaml", "toml"])
const invisible = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u115f\u1160\u3164\uffa0\u2800]/u
const references = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/u
const closing = /(?:^|[^\p{L}])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?::\s*|\s+)(?:#[0-9]|gh-[0-9]|[a-z0-9_.-]+\/[a-z0-9_.-]+#|https?:\/\/|github\.com\/[^\s]*\/(?:issues|pull)\/)/u

/** Validate literal Markdown; return false on every ambiguous fence. */
export function safePublication(value) {
  if (!value.isWellFormed() || invisible.test(value.replaceAll("\n", "")) || references.test(value)) return false
  if (closing.test(fold(value).replace(/[*_~`[\]()]/g, ""))) return false
  let fence = null
  let blank = true
  for (const line of value.split("\n")) {
    if (/^ {0,3}\[[^\]]*\]:/.test(line) || /^ +(?:`{3,}|~{3,})/.test(line)) return false
    if (fence !== null) {
      if (line === fence) fence = null
      else if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) return false
    } else {
      if (/^ {0,3}(?:> ?|(?:[-+*]|[0-9]+[.)]) +).*(?:`{3,}|~{3,})/.test(line)) return false
      const opener = /^(`{3,}|~{3,})(.*)$/.exec(line)
      if (opener !== null) {
        if (!blank || !languages.has(opener[2])) return false
        fence = opener[1]
      } else if (/[<@$]/.test(line)) return false
    }
    blank = /^ *$/.test(line)
  }
  return fence === null
}
