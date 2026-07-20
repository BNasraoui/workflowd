import { effectCallback, syncDecoderInvocationName, visitFunctionBody } from "./ast.mjs"

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow synchronous Schema decoder calls in Effect.gen callbacks",
    },
    schema: [],
    messages: {
      syncDecode:
        "{{decoder}} can throw inside Effect.gen; use an Effect-returning decoder or a typed failure boundary.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode
    const checkedCallbacks = new WeakSet()

    return {
      CallExpression(node) {
        const callback = effectCallback(
          node,
          "gen",
          sourceCode,
          (candidate) => candidate.generator === true,
        )
        if (callback === undefined || checkedCallbacks.has(callback)) return
        checkedCallbacks.add(callback)
        visitFunctionBody(callback, sourceCode, (candidate) => {
          if (candidate.type !== "CallExpression") return
          const decoder = syncDecoderInvocationName(candidate, sourceCode)
          if (decoder !== undefined) {
            context.report({ node: candidate, messageId: "syncDecode", data: { decoder } })
          }
        })
      },
    }
  },
}
