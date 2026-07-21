import noDirectThrowInGen from "./no-direct-throw-in-gen.mjs"
import noSyncSchemaDecodeInGen from "./no-sync-schema-decode-in-gen.mjs"
import noThrowingOperationInSync from "./no-throwing-operation-in-sync.mjs"
import requirePromiseRejectionHandler from "./require-promise-rejection-handler.mjs"

export const rules = {
  "no-direct-throw-in-gen": noDirectThrowInGen,
  "no-throwing-operation-in-sync": noThrowingOperationInSync,
  "require-promise-rejection-handler": requirePromiseRejectionHandler,
  "no-sync-schema-decode-in-gen": noSyncSchemaDecodeInGen,
}

const plugin = {
  meta: {
    name: "workflowd-effect",
    version: "0.1.0",
  },
  rules,
}

export default plugin
