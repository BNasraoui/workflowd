import { expect, test } from "bun:test"
import { parseReloadEnvironment } from "../src/config-env-file"

test("reads systemd env assignments without evaluating shell syntax", () => {
  expect(
    parseReloadEnvironment(
      `# comment\n; comment\nA= first value \nB='literal $HOME # hash'\nC="escaped \\"quote\\" \\$HOME"\nD=one\\\ntwo\nE=\nJSON='[{"a":"b"}]'\n`,
    ),
  ).toEqual({
    A: "first value",
    B: "literal $HOME # hash",
    C: 'escaped "quote" $HOME',
    D: "onetwo",
    E: "",
    JSON: '[{"a":"b"}]',
  })
})

test("rejects malformed env files without reporting their contents", () => {
  for (const content of [
    "secret-value",
    "A='secret-value",
    'A="secret-value',
    "export A=secret-value",
    "A='secret-value' trailing",
    "A=secret-value\\",
  ]) {
    expect(() => parseReloadEnvironment(content)).toThrow("Invalid environment file")
    try {
      parseReloadEnvironment(content)
    } catch (error) {
      expect(String(error)).not.toContain("secret-value")
    }
  }
})

test("preserves escaped outer whitespace and owns prototype-like names", () => {
  const parsed = parseReloadEnvironment("A=x\\ \nB=\\ x\\ \nC=x\\ \n__proto__=safe\n")
  expect(parsed.A).toBe("x ")
  expect(parsed.B).toBe(" x ")
  expect(parsed.C).toBe("x ")
  expect(Object.hasOwn(parsed, "__proto__")).toBe(true)
  expect(parsed.__proto__).toBe("safe")
})
