const invalid = () => new Error("Invalid environment file")

class EnvironmentFile {
  private offset = 0
  constructor(private readonly text: string) {}

  parse(): Record<string, string> {
    const result: Record<string, string> = Object.create(null)
    while (this.offset < this.text.length) {
      const end = this.lineEnd()
      const line = this.text.slice(this.offset, end).trim()
      if (line === "" || line.startsWith("#") || line.startsWith(";")) {
        this.offset = end + 1
        continue
      }
      const match = /^[ \t]*([A-Za-z_]\w*)[ \t]*=[ \t]*/.exec(this.text.slice(this.offset))
      if (match === null) throw invalid()
      this.offset += match[0].length
      const first = this.text[this.offset]
      const quote = first === "'" || first === '"' ? first : undefined
      if (quote !== undefined) this.offset++
      result[match[1]!] = this.value(quote)
    }
    return result
  }

  private lineEnd(): number {
    const end = this.text.indexOf("\n", this.offset)
    return end === -1 ? this.text.length : end
  }

  private finishQuote() {
    const end = this.lineEnd()
    if (this.text.slice(this.offset, end).trim() !== "") throw invalid()
    this.offset = end + 1
  }

  private escape(quote: string | undefined): string {
    const next = this.text[this.offset++]
    if (next === undefined) throw invalid()
    if (next === "\n") return ""
    if (quote === '"' && !['"', "\\", "$", "`"].includes(next)) return `\\${next}`
    return next
  }

  private value(quote: string | undefined): string {
    let value = ""
    let keep = 0
    while (this.offset < this.text.length) {
      const char = this.text[this.offset++]!
      if (quote !== undefined && char === quote) {
        this.finishQuote()
        return value
      }
      if (quote === undefined && char === "\n") return value.slice(0, keep)
      const escaped = char === "\\" && quote !== "'"
      const part = escaped ? this.escape(quote) : char
      value += part
      if (part !== "" && (escaped || !/\s/.test(char))) keep = value.length
    }
    if (quote !== undefined) throw invalid()
    return value.slice(0, keep)
  }
}

/** Strict systemd EnvironmentFile assignments. No shell expansion or export. */
export function parseReloadEnvironment(content: string): Record<string, string> {
  if (content.includes("\0") || content.startsWith("\uFEFF")) throw invalid()
  return new EnvironmentFile(content.replaceAll("\r\n", "\n")).parse()
}
