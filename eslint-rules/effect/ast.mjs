const functionTypes = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
])

const effectModules = new Set(["effect", "effect/Effect"])
const schemaModules = new Set(["effect", "effect/Schema"])
const syncDecoderNames = new Set(["decodeSync", "decodeUnknownSync"])

function propertyName(member) {
  if (!member.computed && member.property.type === "Identifier") return member.property.name
  if (member.computed && member.property.type === "Literal") return member.property.value
  return undefined
}

function findVariable(identifier, sourceCode) {
  for (let scope = sourceCode.getScope(identifier); scope !== null; scope = scope.upper) {
    const variable = scope.set.get(identifier.name)
    if (variable !== undefined) return variable
  }
  return undefined
}

function constInitializer(identifier, sourceCode) {
  const variable = findVariable(identifier, sourceCode)
  const definition = variable?.defs.find((candidate) => candidate.type === "Variable")
  if (
    definition === undefined ||
    definition.node.type !== "VariableDeclarator" ||
    definition.node.id.type !== "Identifier" ||
    definition.node.id.name !== identifier.name ||
    definition.parent.type !== "VariableDeclaration" ||
    definition.parent.kind !== "const" ||
    definition.node.init === null
  ) {
    return undefined
  }
  return { variable, initializer: definition.node.init }
}

function importedBinding(identifier, sourceCode) {
  const variable = findVariable(identifier, sourceCode)
  const definition = variable?.defs.find((candidate) => candidate.type === "ImportBinding")
  if (definition === undefined || definition.parent.type !== "ImportDeclaration") return undefined

  const source = definition.parent.source.value
  if (typeof source !== "string") return undefined
  if (definition.node.type === "ImportNamespaceSpecifier") return { source, imported: "*" }
  if (definition.node.type === "ImportDefaultSpecifier") return { source, imported: "default" }
  if (definition.node.type !== "ImportSpecifier") return undefined

  const imported = definition.node.imported
  if (imported.type === "Identifier") return { source, imported: imported.name }
  return typeof imported.value === "string" ? { source, imported: imported.value } : undefined
}

function isRootModuleNamespace(node, sourceCode, seen) {
  if (node.type !== "Identifier") return false
  const binding = importedBinding(node, sourceCode)
  if (binding?.source === "effect" && binding.imported === "*") return true

  const constant = constInitializer(node, sourceCode)
  if (constant === undefined || seen.has(constant.variable)) return false
  seen.add(constant.variable)
  return isRootModuleNamespace(constant.initializer, sourceCode, seen)
}

function isPackageNamespace(node, sourceCode, packageModules, packageExport, seen) {
  if (node.type === "Identifier") {
    const binding = importedBinding(node, sourceCode)
    if (binding !== undefined && packageModules.has(binding.source)) {
      return binding.source === "effect"
        ? binding.imported === packageExport
        : binding.imported === "*"
    }

    const constant = constInitializer(node, sourceCode)
    if (constant === undefined || seen.has(constant.variable)) return false
    seen.add(constant.variable)
    return isPackageNamespace(constant.initializer, sourceCode, packageModules, packageExport, seen)
  }

  return (
    node.type === "MemberExpression" &&
    propertyName(node) === packageExport &&
    isRootModuleNamespace(node.object, sourceCode, seen)
  )
}

function isPackageMember(
  node,
  sourceCode,
  packageModules,
  packageExport,
  memberName,
  seen = new Set(),
) {
  if (node.type === "Identifier") {
    const binding = importedBinding(node, sourceCode)
    if (
      binding !== undefined &&
      binding.source !== "effect" &&
      packageModules.has(binding.source) &&
      binding.imported === memberName
    ) {
      return true
    }

    const constant = constInitializer(node, sourceCode)
    if (constant === undefined || seen.has(constant.variable)) return false
    seen.add(constant.variable)
    return isPackageMember(
      constant.initializer,
      sourceCode,
      packageModules,
      packageExport,
      memberName,
      seen,
    )
  }

  if (node.type !== "MemberExpression" || propertyName(node) !== memberName) return false
  return isPackageNamespace(node.object, sourceCode, packageModules, packageExport, new Set())
}

export function isEffectMember(node, memberName, sourceCode) {
  return isPackageMember(node, sourceCode, effectModules, "Effect", memberName)
}

function schemaDecoderFactoryName(call, sourceCode) {
  for (const decoderName of syncDecoderNames) {
    if (isPackageMember(call.callee, sourceCode, schemaModules, "Schema", decoderName)) {
      return `Schema.${decoderName}`
    }
  }
  return undefined
}

function localDecoderFactoryName(identifier, sourceCode, seen = new Set()) {
  const constant = constInitializer(identifier, sourceCode)
  if (constant === undefined || seen.has(constant.variable)) return undefined
  seen.add(constant.variable)

  if (constant.initializer.type === "CallExpression") {
    return schemaDecoderFactoryName(constant.initializer, sourceCode)
  }
  if (constant.initializer.type === "Identifier") {
    return localDecoderFactoryName(constant.initializer, sourceCode, seen)
  }
  return undefined
}

export function syncDecoderInvocationName(call, sourceCode) {
  if (call.callee.type === "CallExpression") {
    return schemaDecoderFactoryName(call.callee, sourceCode)
  }
  if (call.callee.type === "Identifier") {
    return localDecoderFactoryName(call.callee, sourceCode)
  }
  return undefined
}

export function resolveLocalFunction(node, sourceCode, seen = new Set()) {
  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") return node
  if (node.type !== "Identifier") return undefined

  const variable = findVariable(node, sourceCode)
  if (variable === undefined || seen.has(variable)) return undefined
  seen.add(variable)

  const functionDefinition = variable.defs.find((candidate) => candidate.type === "FunctionName")
  if (functionDefinition?.node.type === "FunctionDeclaration") return functionDefinition.node

  const constant = constInitializer(node, sourceCode)
  if (constant === undefined) return undefined
  return resolveLocalFunction(constant.initializer, sourceCode, seen)
}

export function effectCallback(call, memberName, sourceCode, predicate = () => true) {
  if (!isEffectMember(call.callee, memberName, sourceCode)) return undefined
  const argument = call.arguments.at(-1)
  if (argument === undefined || argument.type === "SpreadElement") return undefined
  const callback = resolveLocalFunction(argument, sourceCode)
  if (callback === undefined || !predicate(callback)) return undefined
  return callback
}

export function visitFunctionBody(callback, sourceCode, visitor) {
  function visit(node) {
    if (functionTypes.has(node.type)) return
    visitor(node)
    for (const key of sourceCode.visitorKeys[node.type] ?? []) {
      const child = node[key]
      if (Array.isArray(child)) {
        for (const item of child) visit(item)
      } else if (child !== null && typeof child === "object") {
        visit(child)
      }
    }
  }

  visit(callback.body)
}

export function isUnshadowedGlobal(identifier, sourceCode) {
  const variable = findVariable(identifier, sourceCode)
  return variable === undefined || variable.defs.length === 0
}

export function memberName(member) {
  return propertyName(member)
}

export function isCallableHandler(node, sourceCode) {
  if (node === undefined || node.type === "SpreadElement") return false

  const services = sourceCode.parserServices
  if (services?.program != null && services.esTreeNodeToTSNodeMap !== undefined) {
    const typeScriptNode = services.esTreeNodeToTSNodeMap.get(node)
    const type = services.program.getTypeChecker().getTypeAtLocation(typeScriptNode)
    return type.getCallSignatures().length > 0
  }

  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") return true
  if (node.type === "MemberExpression") return true
  if (node.type !== "Identifier") return false

  const binding = importedBinding(node, sourceCode)
  if (binding !== undefined) return binding.imported !== "*"
  return resolveLocalFunction(node, sourceCode) !== undefined
}
