import { describe, expect, test } from "bun:test"
import { verifyWebhookSignature } from "../src/webhook"

describe("verifyWebhookSignature", () => {
  test("accepts GitHub's published signature test vector", () => {
    expect(
      verifyWebhookSignature({
        body: "Hello, World!",
        secret: "It's a Secret to Everybody",
        signature: "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
      }),
    ).toBe(true)
  })

  test("accepts uppercase hexadecimal digest characters", () => {
    expect(
      verifyWebhookSignature({
        body: "Hello, World!",
        secret: "It's a Secret to Everybody",
        signature: "sha256=757107EA0EB2509FC211221CCE984B8A37570B6D7586C22C46F4379C8B043E17",
      }),
    ).toBe(true)
  })

  test.each([
    [
      "a trailing byte",
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e1700",
    ],
    [
      "trailing text",
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17junk",
    ],
    ["an odd-length digest", `sha256=${"a".repeat(63)}`],
    ["non-hexadecimal characters", `sha256=${"g".repeat(64)}`],
    ["a short digest", `sha256=${"a".repeat(62)}`],
    ["a long digest", `sha256=${"a".repeat(66)}`],
    ["a differently-cased prefix", `SHA256=${"a".repeat(64)}`],
  ])("rejects %s", (_description, signature) => {
    expect(
      verifyWebhookSignature({
        body: "Hello, World!",
        secret: "It's a Secret to Everybody",
        signature,
      }),
    ).toBe(false)
  })
})
