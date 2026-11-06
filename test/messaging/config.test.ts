import { expect, test } from "bun:test"
import { loadConfig } from "../../src/config"
import { loadRemoteProcessConfig } from "../../src/remote/config"

test("messaging opt-in requires the existing daemon discovery authority", async () => {
  await expect(
    loadConfig({
      WORKFLOWD_MODE: "execution",
      WORKFLOWD_HOST_ID: "fixture",
      WORKFLOWD_MESSAGING_ENABLED: "true",
    }),
  ).rejects.toThrow("Messaging requires")
})
test("messaging opt-in refuses malformed flags and unenrolled runners", async () => {
  await expect(
    loadConfig({
      WORKFLOWD_MODE: "execution",
      WORKFLOWD_HOST_ID: "fixture",
      WORKFLOWD_MESSAGING_ENABLED: "yes",
    }),
  ).rejects.toThrow("must be true or false")
  await expect(
    loadRemoteProcessConfig({
      WORKFLOWD_REMOTE_HOST_ID: "fixture",
      WORKFLOWD_NATS_SERVERS: "nats://127.0.0.1:1234",
      WORKFLOWD_NATS_TOKEN: "fixture",
      WORKFLOWD_MESSAGING_ENABLED: "true",
    }),
  ).rejects.toThrow("Messaging requires")
})
