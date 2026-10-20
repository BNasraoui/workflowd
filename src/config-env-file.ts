/** Strict systemd EnvironmentFile assignments. No shell expansion or export. */
export function parseReloadEnvironment(content: string): Record<string, string> {
  const invalid = () => new Error("Invalid environment file")
  if (content.includes("\0") || content.startsWith("\uFEFF")) throw invalid()
  const text = content.replace(/\r\n/g, "\n")
  const result: Record<string, string> = {}
  let offset = 0
  while (offset < text.length) {
    const end = text.indexOf("\n", offset)
    const lineEnd = end === -1 ? text.length : end
    const line = text.slice(offset, lineEnd).trim()
    if (line === "" || line.startsWith("#") || line.startsWith(";")) {
      offset = lineEnd + 1
      continue
    }
    const match = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*/.exec(text.slice(offset))
    if (match === null) throw invalid()
    const name = match[1]!
    offset += match[0].length
    const quote = text[offset] === "'" || text[offset] === '"' ? text[offset++] : undefined
    let value = ""
    let closed = quote === undefined
    while (offset < text.length) {
      const char = text[offset++]!
      if (quote !== undefined && char === quote) {
        closed = true
        break
      }
      if (quote === undefined && char === "\n") break
      if (char === "\\" && quote !== "'") {
        const next = text[offset++]
        if (next === undefined) throw invalid()
        if (next === "\n") continue
        if (quote === '"' && !['"', "\\", "$", "`"].includes(next)) value += "\\"
        value += next
      } else value += char
    }
    if (!closed) throw invalid()
    if (quote !== undefined) {
      const restEnd = text.indexOf("\n", offset)
      const trailingEnd = restEnd === -1 ? text.length : restEnd
      if (text.slice(offset, trailingEnd).trim() !== "") throw invalid()
      offset = trailingEnd + 1
    }
    result[name] = quote === undefined ? value.trim() : value
  }
  return result
}
