import {
  effectCallback,
  isUnshadowedGlobal,
  memberName,
  syncDecoderInvocationName,
  visitFunctionBody,
} from "./ast.mjs"

function bunServeName(call, sourceCode) {
  if (
    call.callee.type !== "MemberExpression" ||
    memberName(call.callee) !== "serve" ||
    call.callee.object.type !== "Identifier" ||
    call.callee.object.name !== "Bun" ||
    !isUnshadowedGlobal(call.callee.object, sourceCode)
  ) {
    return undefined
  }
  return "Bun.serve"
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow configured throwing host operations in Effect.sync callbacks",
    },
    schema: [],
    messages: {
      throwingOperation:
        "{{operation}} can throw; use Effect.try, Effect.tryPromise, or another typed failure boundary.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode
    const checkedCallbacks = new WeakSet()

    return {
      CallExpression(node) {
        const callback = effectCallback(node, "sync", sourceCode)
        if (callback === undefined || checkedCallbacks.has(callback)) return
        checkedCallbacks.add(callback)
        visitFunctionBody(callback, sourceCode, (candidate) => {
          if (candidate.type !== "CallExpression") return
          const operation =
            bunServeName(candidate, sourceCode) ?? syncDecoderInvocationName(candidate, sourceCode)
          if (operation !== undefined) {
            context.report({
              node: candidate,
              messageId: "throwingOperation",
              data: { operation },
            })
          }
        })
      },
    }
  },
}
