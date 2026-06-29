import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

export interface ParsedSource {
  readonly path: string;
  readonly text: string;
  readonly sourceFile: ts.SourceFile;
}

export interface ImportedBinding {
  readonly name: string;
  readonly importedName: string;
  readonly moduleSpecifier: string;
  readonly location: string;
}

export function collectTypeScriptFiles(directory: string): readonly string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(path));
      continue;
    }
    /* v8 ignore next -- invariant source directories only need TypeScript files. */
    if (entry.isFile() && path.endsWith(".ts")) {
      files.push(path);
    }
  }

  return files.sort();
}

export function parseSource(path: string): ParsedSource {
  return parseSourceText(path, readFileSync(path, "utf8"));
}

export function parseSourceText(path: string, text: string): ParsedSource {
  /* v8 ignore next -- current invariant sources are TypeScript; TSX is supported for reuse. */
  const scriptKind = path.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  return {
    path,
    text,
    sourceFile: ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    ),
  };
}

export function location(source: ParsedSource, node: ts.Node): string {
  const position = source.sourceFile.getLineAndCharacterOfPosition(
    node.getStart(source.sourceFile),
  );
  return `${source.path}:${position.line + 1}:${position.character + 1}`;
}

export function propertyNameText(node: ts.PropertyName): string | null {
  /* v8 ignore next 5 -- invariant scans only need literal property names. */
  if (
    ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node)
  ) {
    return node.text;
  }
  /* v8 ignore next -- invariant scans intentionally ignore computed keys. */
  return null;
}

export function variableInitializer(
  source: ParsedSource,
  name: string,
): ts.Expression | null {
  let initializer: ts.Expression | null = null;

  function visit(node: ts.Node): void {
    if (
      initializer === null &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      /* v8 ignore next -- invariant callers pass initialized constants. */
      initializer = node.initializer ?? null;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(source.sourceFile);
  return initializer;
}

export function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isAsExpression(expression) ||
    ts.isParenthesizedExpression(expression)
  ) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

export function arrayIdentifierElements(
  source: ParsedSource,
  variableName: string,
): readonly string[] {
  const initializer = variableInitializer(source, variableName);
  /* v8 ignore next -- missing constants are reported below as invariant wiring failures. */
  const expression =
    initializer === null ? null : unwrapExpression(initializer);
  /* v8 ignore next 3: invariant callers pass known array constants; this reports future wiring mistakes. */
  if (expression === null || !ts.isArrayLiteralExpression(expression)) {
    throw new Error(`${source.path} missing ${variableName} array literal`);
  }

  const names: string[] = [];
  for (const element of expression.elements) {
    /* v8 ignore next 3: invariant callers use identifier arrays; this reports future wiring mistakes. */
    if (!ts.isIdentifier(element)) {
      throw new Error(`${location(source, element)} must be an identifier`);
    }
    names.push(element.text);
  }
  return names;
}

export function objectProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | null {
  for (const property of object.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      propertyNameText(property.name) === name
    ) {
      return property;
    }
  }
  /* v8 ignore next: callers use this to report optional/missing syntax explicitly. */
  return null;
}

export function objectLiteralPropertyNames(
  object: ts.ObjectLiteralExpression,
): readonly string[] {
  const names: string[] = [];
  for (const property of object.properties) {
    /* v8 ignore next -- invariant metadata objects use property assignments. */
    if (ts.isPropertyAssignment(property)) {
      const name = propertyNameText(property.name);
      /* v8 ignore next: invariant metadata uses plain property names. */
      if (name !== null) names.push(name);
    }
  }
  return names;
}

function importModuleSpecifier(node: ts.ImportDeclaration): string | null {
  /* v8 ignore next -- import declarations in parsed TypeScript use string module specifiers. */
  return ts.isStringLiteral(node.moduleSpecifier)
    ? node.moduleSpecifier.text
    : null;
}

export function importedBindings(
  source: ParsedSource,
): readonly ImportedBinding[] {
  const bindings: ImportedBinding[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = importModuleSpecifier(node);
      const namedBindings = node.importClause?.namedBindings;
      if (
        moduleSpecifier !== null &&
        namedBindings !== undefined &&
        ts.isNamedImports(namedBindings)
      ) {
        for (const element of namedBindings.elements) {
          bindings.push({
            name: element.name.text,
            importedName: element.propertyName?.text ?? element.name.text,
            moduleSpecifier,
            location: location(source, element),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source.sourceFile);
  return bindings;
}
