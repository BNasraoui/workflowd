import { effectCallback, visitFunctionBody } from "./ast.mjs"

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow direct throw statements in Effect.gen callbacks",
    },
    schema: [],
    messages: {
      directThrow:
        "Do not throw directly from an Effect.gen callback; represent failure in Effect.",
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
          if (candidate.type === "ThrowStatement") {
            context.report({ node: candidate, messageId: "directThrow" })
          }
        })
      },
    }
  },
}
