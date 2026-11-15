import { test } from "bun:test"
import { publisherHttpCase } from "./publisher-http-case"

for (const fault of ["approved pin", "approved pin collision"]) {
  test(
    `real publisher create-only Git/HTTP receipt: ${fault}`,
    () => publisherHttpCase(fault),
    30000,
  )
}
