import { posix } from "node:path";
import ts from "typescript";
import { readTsconfigAlias } from "../../shared/tsconfig-alias.js";

const UNKNOWN = "\u0000";
const MAX_VALUES = 64;
type Component = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
type Environment = ReadonlyMap<ts.Symbol, string[]>;

function unwrap(node: ts.Node): ts.Node {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
    || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
  return node;
}

/** Prove that every render path forwards elsewhere; unknown behavior remains capturable. */
export function expoRedirectTargets(files: ReadonlyMap<string, string>, routeFiles: readonly string[], platform = "ios"): Map<string, string[]> {
  const extensions = ["tsx", "ts", "jsx", "js"].flatMap(ext => [`.${platform}.${ext}`, ...(platform === "web" ? [] : [`.native.${ext}`]), `.${ext}`]).concat([".mjs", ".cjs"]);
  const sources = new Map<string, ts.SourceFile | undefined>();
  let sourceBytes = 0;
  const sourceFile = (name: string): ts.SourceFile | undefined => {
    const path = name.replace(/^\//, "");
    if (sources.has(path)) return sources.get(path);
    sources.set(path, undefined);
    const text = files.get(path);
    if (text === undefined || !/\.[cm]?[jt]sx?$/.test(path)) return undefined;
    const bytes = Buffer.byteLength(text);
    if (bytes > 2 * 1024 * 1024 || sourceBytes + bytes > 32 * 1024 * 1024) return undefined;
    sourceBytes += bytes;
    const ast = ts.createSourceFile(`/${path}`, text, ts.ScriptTarget.Latest, true);
    if ((ast as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) return undefined;
    sources.set(path, ast);
    return ast;
  };
  const alias = readTsconfigAlias(files.get("tsconfig.json"));
  const resolveModule = (specifier: string, importer: string): string | undefined => {
    const base = specifier.startsWith("@/") && !alias.unsupported ? `${alias.target}${specifier.slice(2)}`
      : specifier.startsWith(".") ? posix.normalize(posix.join(posix.dirname(importer.replace(/^\//, "")), specifier)) : undefined;
    if (!base || base.startsWith("../")) return undefined;
    const withoutJs = base.replace(/\.[cm]?jsx?$/, "");
    return [...extensions.map(ext => base + ext), base, ...extensions.map(ext => `${base}/index${ext}`),
      ...extensions.map(ext => withoutJs + ext)].find(path => /\.[cm]?[jt]sx?$/.test(path) && files.has(path));
  };
  const host: ts.CompilerHost = {
    getSourceFile: sourceFile, getDefaultLibFileName: () => "", writeFile: () => {}, getCurrentDirectory: () => "/",
    getDirectories: () => [], getCanonicalFileName: path => path, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
    fileExists: path => files.has(path.replace(/^\//, "")), readFile: path => files.get(path.replace(/^\//, "")),
    resolveModuleNames: (names, importer) => names.map(name => {
      const resolved = resolveModule(name, importer);
      return resolved ? { resolvedFileName: `/${resolved}`, isExternalLibraryImport: false } : undefined;
    }),
  };
  const program = ts.createProgram([...new Set(routeFiles)].sort().map(path => `/${path}`), {
    noLib: true, allowJs: true, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve,
  }, host);
  const checker = program.getTypeChecker();
  const symbol = (node: ts.Node): ts.Symbol | undefined => {
    const value = checker.getSymbolAtLocation(node);
    return value && value.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(value) : value;
  };
  const writes = new Set<ts.Symbol>();
  for (const ast of program.getSourceFiles()) {
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        const binding = symbol(node.left); if (binding) writes.add(binding);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  const imported = (node: ts.Node, module: string, name: string): boolean => {
    if (ts.isPropertyAccessExpression(node)) {
      return node.name.text === name && (checker.getSymbolAtLocation(node.expression)?.declarations ?? []).some(declaration => (
        ts.isNamespaceImport(declaration) && ts.isStringLiteral(declaration.parent.parent.moduleSpecifier)
        && declaration.parent.parent.moduleSpecifier.text === module
      ));
    }
    return (checker.getSymbolAtLocation(node)?.declarations ?? []).some(declaration => ts.isImportSpecifier(declaration)
      && !declaration.isTypeOnly && !declaration.parent.parent.isTypeOnly
      && (declaration.propertyName?.text ?? declaration.name.text) === name
      && ts.isStringLiteral(declaration.parent.parent.parent.moduleSpecifier)
      && declaration.parent.parent.parent.moduleSpecifier.text === module);
  };
  const definition = (node: ts.Node): ts.Node | undefined => {
    const binding = symbol(node);
    if (!binding || writes.has(binding)) return undefined;
    const declaration = binding.declarations?.[0];
    if (declaration && ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
      && declaration.parent.flags & ts.NodeFlags.Const) return declaration.initializer;
    // Object properties can be mutated through aliases or passed to arbitrary code.
    if (declaration && ts.isFunctionDeclaration(declaration)) return declaration;
    return undefined;
  };
  let operations = 0;
  const visiting = new Set<ts.Node>();
  const enter = <T>(node: ts.Node, read: () => T, fallback: T): T => {
    if (++operations > 10_000 || visiting.size >= 64 || visiting.has(node)) return fallback;
    visiting.add(node);
    try { return read(); } finally { visiting.delete(node); }
  };
  const fn = (input: ts.Node): Component | undefined => {
    const node = unwrap(input);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) {
      return node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) ? undefined : node;
    }
    return enter(node, () => { const value = definition(node); return value ? fn(value) : undefined; }, undefined);
  };
  const union = (values: string[][]): string[] => {
    const result = [...new Set(values.flat())];
    return result.length > MAX_VALUES ? [UNKNOWN] : result;
  };
  const text = (input: ts.Node, env: Environment = new Map()): string[] => {
    const node = unwrap(input);
    return enter(node, () => {
      if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return [node.text];
      if (ts.isConditionalExpression(node)) return union([text(node.whenTrue, env), text(node.whenFalse, env)]);
      if (ts.isTemplateExpression(node)) {
        let values = [node.head.text];
        for (const part of node.templateSpans) {
          values = union(values.map(prefix => text(part.expression, env).map(value => prefix + value + part.literal.text)));
        }
        return values;
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        return union(text(node.left, env).map(left => text(node.right, env).map(right => left + right)));
      }
      if (ts.isCallExpression(node)) {
        const callable = fn(node.expression);
        if (!callable?.body) return [UNKNOWN];
        const nested = new Map(env);
        callable.parameters.forEach((parameter, index) => {
          const binding = symbol(parameter.name);
          const argument = node.arguments[index] ?? parameter.initializer;
          if (binding) nested.set(binding, argument ? text(argument, env) : [UNKNOWN]);
        });
        const body = callable.body;
        if (!ts.isBlock(body)) return text(body, nested);
        // Small pure route helpers only. Unknown control flow never supplies a guessed path.
        if (body.statements.slice(0, -1).some(statement => !ts.isVariableStatement(statement))) return [UNKNOWN];
        const last = body.statements.at(-1);
        return last && ts.isReturnStatement(last) && last.expression ? text(last.expression, nested) : [UNKNOWN];
      }
      const binding = symbol(node);
      if (binding && env.has(binding)) return env.get(binding)!;
      const value = definition(node);
      return value ? text(value, env) : [UNKNOWN];
    }, [UNKNOWN]);
  };
  const targets = (input: ts.Node): string[] | undefined => {
    let node = unwrap(input);
    if (ts.isObjectLiteralExpression(node)) {
      if (node.properties.some(ts.isSpreadAssignment)) return undefined;
      const property = node.properties.find(property => ts.isPropertyAssignment(property)
        && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) && property.name.text === "pathname");
      if (!property || !ts.isPropertyAssignment(property)) return undefined;
      node = property.initializer;
    }
    const paths = text(node).map(value => value.split(/[?#]/, 1)[0]!);
    return paths.length && paths.every(path => path.startsWith("/") && !path.startsWith("//") && !/[\u0000-\u001f\u007f\\]/.test(path)
      && !path.split("/").some(part => part === "." || part === "..")) ? [...new Set(paths)].sort() : undefined;
  };
  const router = (input: ts.Node): boolean => {
    const node = unwrap(input);
    if (imported(node, "expo-router", "router")) return true;
    if (ts.isCallExpression(node)) return imported(node.expression, "expo-router", "useRouter");
    return enter(node, () => { const value = definition(node); return Boolean(value && router(value)); }, false);
  };
  const replace = (input: ts.Node): string[] | undefined => {
    const node = unwrap(input);
    return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "replace"
      && router(node.expression.expression) && node.arguments.length === 1 ? targets(node.arguments[0]!) : undefined;
  };
  const statementsOf = (node: ts.Statement): readonly ts.Statement[] => ts.isBlock(node) ? node.statements : [node];
  const combine = (left: string[] | undefined, right: string[] | undefined): string[] | undefined => {
    const paths = left && right ? [...new Set([...left, ...right])].sort() : undefined;
    return paths && paths.length <= MAX_VALUES ? paths : undefined;
  };
  const effectBody = (statements: readonly ts.Statement[], found: string[] = [], depth = 0): string[] | undefined => {
    if (++operations > 10_000 || depth > 64 || statements.length > 256) return undefined;
    const [first, ...rest] = statements;
    if (!first) return found.length ? found : undefined;
    if (ts.isVariableStatement(first) || ts.isEmptyStatement(first)) return effectBody(rest, found, depth + 1);
    if (ts.isBlock(first)) return effectBody([...first.statements, ...rest], found, depth + 1);
    if (ts.isIfStatement(first)) return combine(effectBody([...statementsOf(first.thenStatement), ...rest], found, depth + 1),
      effectBody([...(first.elseStatement ? statementsOf(first.elseStatement) : []), ...rest], found, depth + 1));
    if (ts.isExpressionStatement(first)) {
      const next = replace(first.expression);
      return next ? effectBody(rest, [...found, ...next], depth + 1) : undefined;
    }
    if (ts.isReturnStatement(first)) {
      const next = first.expression ? replace(first.expression) : undefined;
      return next ? [...found, ...next] : !first.expression && found.length ? found : undefined;
    }
    return undefined;
  };
  const effect = (input: ts.Expression): string[] | undefined => {
    const node = unwrap(input);
    if (!ts.isCallExpression(node) || !imported(node.expression, "react", "useEffect") || !node.arguments[0]) return undefined;
    const callback = fn(node.arguments[0]);
    if (!callback?.body) return undefined;
    return ts.isBlock(callback.body) ? effectBody(callback.body.statements) : replace(callback.body);
  };
  const render = (input: ts.Node, effects: string[]): string[] | undefined => {
    const node = unwrap(input);
    return enter(node, () => {
      if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return effects.length ? effects : undefined;
      if (ts.isConditionalExpression(node)) return combine(render(node.whenTrue, effects), render(node.whenFalse, effects));
      if (ts.isJsxFragment(node)) {
        const children = node.children.filter(child => !ts.isJsxText(child) || child.text.trim());
        return children.length === 1 ? render(children[0]!, effects) : children.length === 0 && effects.length ? effects : undefined;
      }
      if (ts.isJsxExpression(node)) return node.expression ? render(node.expression, effects) : undefined;
      const opening = ts.isJsxSelfClosingElement(node) ? node : ts.isJsxElement(node) ? node.openingElement : undefined;
      if (opening) {
        if (imported(opening.tagName, "expo-router", "Redirect")) {
          if (opening.attributes.properties.some(ts.isJsxSpreadAttribute)) return undefined;
          const attribute = opening.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.getText() === "href");
          const value = attribute && ts.isJsxAttribute(attribute) ? attribute.initializer : undefined;
          return value ? targets(ts.isJsxExpression(value) && value.expression ? value.expression : value) : undefined;
        }
        if (opening.attributes.properties.length || ts.isJsxElement(node) && node.children.some(child => !ts.isJsxText(child) || child.text.trim())) return undefined;
        if (imported(opening.tagName, "react-native", "View")) return effects.length ? effects : undefined;
        const component = fn(opening.tagName);
        return component ? componentTargets(component) : undefined;
      }
      const value = definition(node);
      return value ? render(value, effects) : undefined;
    }, undefined);
  };
  const renderBody = (statements: readonly ts.Statement[], effects: string[] = [], depth = 0): string[] | undefined => {
    if (++operations > 10_000 || depth > 64 || statements.length > 256) return undefined;
    const [first, ...rest] = statements;
    if (!first) return undefined;
    if (ts.isVariableStatement(first) || ts.isFunctionDeclaration(first) || ts.isEmptyStatement(first)) return renderBody(rest, effects, depth + 1);
    if (ts.isBlock(first)) return renderBody([...first.statements, ...rest], effects, depth + 1);
    if (ts.isIfStatement(first)) return combine(renderBody([...statementsOf(first.thenStatement), ...rest], effects, depth + 1),
      renderBody([...(first.elseStatement ? statementsOf(first.elseStatement) : []), ...rest], effects, depth + 1));
    if (ts.isExpressionStatement(first)) {
      const next = effect(first.expression);
      return next ? renderBody(rest, [...effects, ...next], depth + 1) : undefined;
    }
    return ts.isReturnStatement(first) && first.expression ? render(first.expression, effects) : undefined;
  };
  const componentTargets = (component: Component): string[] | undefined => enter(component, () => {
    const body = component.body;
    return body ? ts.isBlock(body) ? renderBody(body.statements) : render(body, []) : undefined;
  }, undefined);
  const result = new Map<string, string[]>();
  for (const routeFile of [...new Set(routeFiles)].sort()) {
    operations = 0;
    const ast = program.getSourceFile(`/${routeFile}`);
    const module = ast && checker.getSymbolAtLocation(ast);
    const exported = module && checker.getExportsOfModule(module).find(binding => binding.name === "default");
    const binding = exported && (exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported);
    if (binding && writes.has(binding)) continue;
    const declaration = binding?.declarations?.[0];
    const component = declaration && fn(ts.isExportAssignment(declaration) ? declaration.expression
      : ts.isVariableDeclaration(declaration) && declaration.initializer ? declaration.initializer : declaration);
    const found = component && componentTargets(component);
    const paths = found && [...new Set(found)].sort();
    if (paths?.length && paths.length <= MAX_VALUES && operations <= 10_000) result.set(routeFile, paths);
  }
  return result;
}
