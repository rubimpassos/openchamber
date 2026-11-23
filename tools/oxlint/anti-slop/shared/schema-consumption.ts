import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";
import { isRuntimeFunction, type RuntimeFunction } from "./input-parsers.ts";

function resolveVariable(sourceCode: SourceCode, identifier: ESTree.IdentifierReference): Variable | null {
  let scope: Scope | null = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

function methodCall(identifier: ESTree.Node): ESTree.CallExpression | null {
  const member = identifier.parent;
  if (member.type !== "MemberExpression" || member.object !== identifier || member.computed || member.optional) return null;
  const call = member.parent;
  return call.type === "CallExpression" && call.callee === member && !call.optional ? call : null;
}

function isSafeParseReference(identifier: ESTree.Node): boolean {
  const call = methodCall(identifier);
  return call?.callee.type === "MemberExpression" && call.callee.property.type === "Identifier"
    && call.callee.property.name === "safeParse";
}

function isTypeReference(identifier: ESTree.Node): boolean {
  return identifier.parent.type === "TSQualifiedName" || identifier.parent.type === "TSTypeQuery";
}

function hasPrototypeEscape(call: ESTree.CallExpression): boolean {
  let result: ESTree.Node = call;
  while (result.parent.type === "MemberExpression" && result.parent.object === result) {
    const member = result.parent;
    if (member.computed || member.property.type !== "Identifier"
      || member.property.name === "constructor" || member.property.name === "__proto__") return true;
    const next = member.parent;
    if (next.type !== "CallExpression" || next.callee !== member) break;
    result = next;
  }
  const consumer = result.parent;
  if (consumer.type !== "CallExpression" || consumer.callee.type !== "MemberExpression") return false;
  const property = consumer.callee.property;
  return property.type === "Identifier" && property.name === "getPrototypeOf"
    || property.type === "Literal" && property.value === "getPrototypeOf";
}

function hasSafeZodReferences(variable: Variable): boolean {
  return variable.references.every((reference) => {
    if (!reference.isReadOnly()) return false;
    if (isTypeReference(reference.identifier)) return true;
    const call = methodCall(reference.identifier);
    return call !== null && !hasPrototypeEscape(call);
  });
}

function isZodImport(sourceCode: SourceCode, identifier: ESTree.IdentifierReference): boolean {
  const variable = resolveVariable(sourceCode, identifier);
  if (variable?.defs.length !== 1) return false;
  const definition = variable.defs[0];
  if (definition?.type !== "ImportBinding" || definition.node.type !== "ImportSpecifier"
    || definition.node.importKind === "type" || definition.node.imported.type !== "Identifier"
    || definition.node.imported.name !== "z") return false;
  const declaration = definition.node.parent;
  if (declaration.type !== "ImportDeclaration" || declaration.importKind === "type"
    || declaration.source.value !== "zod") return false;
  // Equivalent imports share the same factories and schema prototypes.
  return sourceCode.ast.body.every((statement) => statement.type !== "ImportDeclaration"
    || statement.source.value !== "zod" || sourceCode.getDeclaredVariables(statement).every((binding) => {
      const specifier = binding.defs[0]?.node;
      if (specifier?.type === "ImportSpecifier") {
        if (specifier.importKind === "type") return true;
        if (specifier.imported.type !== "Identifier" || specifier.imported.name !== "z") {
          return binding.references.every((reference) => {
            const call = reference.identifier.parent;
            return call.type !== "CallExpression" || call.callee !== reference.identifier || !hasPrototypeEscape(call);
          });
        }
      }
      return hasSafeZodReferences(binding);
    }));
}

function isZodObject(sourceCode: SourceCode, expression: ESTree.Expression): boolean {
  if (expression.type !== "CallExpression" || expression.optional) return false;
  const callee = expression.callee;
  if (callee.type !== "MemberExpression" || callee.computed || callee.optional
    || callee.property.type !== "Identifier") return false;
  if (callee.property.name === "strict") {
    return expression.arguments.length === 0 && isZodObject(sourceCode, callee.object);
  }
  return callee.property.name === "object" && callee.object.type === "Identifier"
    && expression.arguments.length === 1 && expression.arguments[0]?.type === "ObjectExpression"
    && isZodImport(sourceCode, callee.object);
}

function isImmutableObjectSchema(sourceCode: SourceCode, identifier: ESTree.IdentifierReference): boolean {
  const variable = resolveVariable(sourceCode, identifier);
  if (variable?.defs.length !== 1) return false;
  const definition = variable.defs[0];
  if (definition?.type !== "Variable" || definition.node.type !== "VariableDeclarator") return false;
  const declaration = definition.node;
  return declaration.id.type === "Identifier" && declaration.parent.type === "VariableDeclaration"
    && declaration.parent.kind === "const" && declaration.init !== null
    && declaration.parent.parent.type !== "ExportNamedDeclaration"
    && isZodObject(sourceCode, declaration.init)
    && variable.references.every((reference) => reference.init
      || reference.isReadOnly() && (isTypeReference(reference.identifier) || isSafeParseReference(reference.identifier)));
}

/** Admit only the raw binding's sole read, directly into a proven object parser. */
export function isSchemaConsumedParameter(
  sourceCode: SourceCode,
  node: RuntimeFunction,
  parameter: ESTree.ParamPattern,
): boolean {
  if (parameter.type !== "Identifier") return false;
  const variable = sourceCode.getDeclaredVariables(node).find((binding) => binding.identifiers.includes(parameter));
  if (variable?.defs.length !== 1 || variable.references.length !== 1) return false;
  if (variable.scope.set.get("arguments")?.references.length) return false;
  if (variable.scope.through.some((binding) => binding.identifier.name === "eval")) return false;
  const reference = variable.references[0];
  if (!reference?.isReadOnly()) return false;
  const identifier = reference.identifier;
  let owner = identifier.parent;
  while (!isRuntimeFunction(owner) && owner.type !== "Program") {
    if (owner.type === "ClassExpression" || owner.type === "ClassDeclaration") return false;
    owner = owner.parent;
  }
  if (owner !== node) return false;
  const call = identifier.parent;
  if (call.type !== "CallExpression" || call.optional || call.arguments.length !== 1
    || call.arguments[0] !== identifier) return false;
  const callee = call.callee;
  return callee.type === "MemberExpression" && !callee.computed && !callee.optional
    && callee.property.type === "Identifier" && callee.property.name === "safeParse"
    && callee.object.type === "Identifier" && isImmutableObjectSchema(sourceCode, callee.object);
}
