import { test } from "bun:test"
import { publisherHttpCase } from "./publisher-http-case"

// The approved-pin cases need the launcher's pinned publisher: publisher-pinned.e2e.launcher.test.ts.
for (const fault of [
  "none",
  "closing references",
  "closing references recovered",
  "closing delayed references",
  "closing delayed query failed",
  "closing query failed",
  "closing query malformed",
  "closing close failed",
  "maximum metadata",
  "existing co-authors",
  "duplicate co-author",
  "invalid co-author",
  "format title",
  "bidi message",
  "fenced mention",
  "collision",
  "race",
  "lost ref reply",
  "wrong tree",
  "wrong parent",
  "wrong message",
  "missing co-author",
  "wrong title",
  "wrong body",
  "binding mismatch",
  "body binding mismatch",
  "unsafe body",
  "lost PR reply",
  "wrong author",
  "wrong head",
  "PR failure",
]) {
  test(
    `real publisher create-only Git/HTTP receipt: ${fault}`,
    () => publisherHttpCase(fault),
    30000,
  )
}
