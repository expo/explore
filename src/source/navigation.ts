import { posix } from "node:path";
import ts from "typescript";
import type { SourceSnapshot } from "./dependency-graph.js";
import { readTsconfigAlias } from "../shared/tsconfig-alias.js";
import { detectAppDir, routeGroupOf } from "./route-providers/expo-router.js";
import { validateSourceRoutes, type SourceRoute } from "../contracts/source-route.js";
import { validateNavigationGraph, type NavigationEdge, type NavigationGraph } from "../contracts/navigation-graph.js";

// A missing runtime value remains unknown. It is never evaluated by executing app code.
const UNKNOWN = Symbol("unknown source value");
const WILDCARD = "\u0000";
type Value = string | number | boolean | null | undefined | typeof UNKNOWN | Value[] | { [key: string]: Value };
type Evaluation = { values: Value[]; unknown: boolean };
type Environment = ReadonlyMap<ts.Symbol, Evaluation>;
const unknown = (): Evaluation => ({ values: [], unknown: true });
const known = (value: Value): Evaluation => ({ values: [value], unknown: false });
const MAX_VALUES = 64;
const MAX_OPERATIONS = 60_000;
const scriptFile = /\.[cm]?[jt]sx?$/;
const NATIVE_TABS = "expo-router/unstable-native-tabs";
const assetFile = /\.(?:css|scss|sass|less|styl|json|png|jpe?g|webp|gif|svg|avif|heic|ico|ttf|otf|woff2?|mp[34]|wav|m4a|aac|webm|mov|pdf)$/i;

function merge(values: Evaluation[]): Evaluation {
  const result = [...new Set(values.flatMap((value) => value.values))];
  return { values: result.slice(0, MAX_VALUES), unknown: result.length > MAX_VALUES || values.some((value) => value.unknown) };
}

function unwrapped(node: ts.Expression): ts.Expression {
  while (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isParenthesizedExpression(node)
    || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
}

function routePath(route: string): string {
  return (route.split("?")[0] ?? "/").split("/").filter((part) => part && !/^\(.*\)$/.test(part)).join("/").replace(/^/, "/");
}

function fileRoute(file: string, appDir: string): string {
  const parts = routeGroupOf(file).slice(appDir.length + 1).split("/").filter((part) => !/^\(.*\)$/.test(part));
  if (parts.at(-1) === "index") parts.pop();
  return `/${parts.join("/")}`;
}

function isObject(value: Value): value is { [key: string]: Value } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Potential navigation, read from the exact committed sources. These edges describe source
 * declarations, never executed actions or proof that a guard permits a particular fixture.
 */
export function extractSourceNavigation(routes: readonly SourceRoute[], files: SourceSnapshot, analysis: { entry?: string; platform?: "ios" | "android" | "web" } = {}): NavigationGraph {
  routes = validateSourceRoutes(routes);
  if (routes.length > 5_000 || files.size > 50_000) throw new Error("Source navigation inventory exceeds its analysis limit");
  const appDir = detectAppDir(files, analysis.entry);
  const platform = analysis.platform ?? "ios";
  const extensions = ["tsx", "ts", "jsx", "js"].flatMap(extension => [`.${platform}.${extension}`, ...(platform === "web" ? [] : [`.native.${extension}`]), `.${extension}`]).concat([".mjs", ".cjs"]);
  const unresolved = new Set<string>();
  const edges = new Map<string, NavigationEdge>();
  const modalSurfaceIds = new Set<string>();
  const asts = new Map<string, ts.SourceFile>();
  const skippedSources = new Set<string>();
  let sourceBytes = 0;
  const diagnosticPath = (path: string): string => path.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 400);
  const alias = readTsconfigAlias(files.get("tsconfig.json"));
  if (alias.unsupported) unresolved.add(`Unresolved navigation: tsconfig.json: ${alias.unsupported}`);
  const resolveModule = (specifier: string, importer: string): string | undefined => {
    const base = specifier.startsWith("@/") ? `${alias.target}${specifier.slice(2)}`
      : specifier.startsWith(".") ? posix.normalize(posix.join(posix.dirname(importer.replace(/^\//, "")), specifier)) : undefined;
    if (!base || base.startsWith("../")) return undefined;
    const withoutJs = /\.[cm]?jsx?$/.test(base) ? base.replace(/\.[cm]?jsx?$/, "") : base;
    return [...extensions.map((ext) => base + ext), base,
      ...extensions.map((ext) => `${base}/index${ext}`),
      ...extensions.map((ext) => withoutJs + ext)].find((path) => scriptFile.test(path) && files.has(path));
  };
  const sourceFile = (path: string): ts.SourceFile | undefined => {
    path = path.replace(/^\//, "");
    if (asts.has(path)) return asts.get(path);
    if (skippedSources.has(path)) return undefined;
    const text = files.get(path);
    if (text === undefined || !/\.[cm]?[jt]sx?$/.test(path)) return undefined;
    const bytes = Buffer.byteLength(text);
    if (bytes > 2 * 1024 * 1024 || sourceBytes + bytes > 32 * 1024 * 1024) {
      skippedSources.add(path);
      unresolved.add(`Unresolved navigation: ${diagnosticPath(path)}: analysis source byte budget exceeded`);
      return undefined;
    }
    sourceBytes += bytes;
    const source = ts.createSourceFile(`/${path}`, text, ts.ScriptTarget.Latest, true);
    asts.set(path, source);
    if ((source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) {
      unresolved.add(`Unresolved navigation: ${diagnosticPath(path)}: source could not be parsed completely`);
    }
    return source;
  };
  const options: ts.CompilerOptions = { noLib: true, allowJs: true, target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve, skipLibCheck: true };
  const host: ts.CompilerHost = {
    getSourceFile: (path) => sourceFile(path), getDefaultLibFileName: () => "", writeFile: () => {},
    getCurrentDirectory: () => "/", getDirectories: () => [], getCanonicalFileName: (path) => path,
    useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
    fileExists: (path) => files.has(path.replace(/^\//, "")), readFile: (path) => files.get(path.replace(/^\//, "")),
    resolveModuleNames: (names, importer) => names.map((name) => {
      const resolved = resolveModule(name, importer);
      return resolved ? { resolvedFileName: `/${resolved}`, isExternalLibraryImport: false } : undefined;
    }),
  };
  const roots = new Set(routes.map((surface) => surface.routeFile).sort());
  for (const file of [...files.keys()].sort()) {
    if (file.startsWith(`${appDir}/`) && /\/_layout\.[jt]sx?$/.test(file)) roots.add(file);
  }
  const program = ts.createProgram([...roots].map((path) => `/${path}`), options, host);
  const checker = program.getTypeChecker();
  const symbol = (node: ts.Node): ts.Symbol | undefined => {
    const found = checker.getSymbolAtLocation(node);
    if (!found || !(found.flags & ts.SymbolFlags.Alias)) return found;
    const resolved = checker.getAliasedSymbol(found);
    return resolved.declarations?.length ? resolved : found;
  };
  const mutated = new Set<ts.Symbol>();
  const referenceAliases = new Map<ts.Symbol, Set<ts.Symbol>>();
  const rootBinding = (node: ts.Expression): ts.Symbol | undefined => {
    while (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) node = node.expression;
    return symbol(node);
  };
  const markMutation = (node: ts.Expression): void => {
    const binding = rootBinding(node);
    if (binding) mutated.add(binding);
  };
  const location = (node: ts.Node) => `${diagnosticPath(node.getSourceFile().fileName.slice(1))}:${node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const issue = (node: ts.Node, reason: string, history = false) => {
    unresolved.add(`${history ? "History-dependent navigation" : "Unresolved navigation"}: ${location(node)}: ${reason}`);
  };

  // Inspect the actual import binding, rather than treating any object named router as Expo Router.
  const expoImport = (node: ts.Node, from: "expo-router" | typeof NATIVE_TABS = "expo-router"): string | undefined => {
    if (ts.isPropertyAccessExpression(node)) {
      const declaration = checker.getSymbolAtLocation(node.expression)?.declarations?.[0];
      if (declaration && ts.isNamespaceImport(declaration)
        && ts.isStringLiteral(declaration.parent.parent.moduleSpecifier)
        && declaration.parent.parent.moduleSpecifier.text === from) return node.name.text;
    }
    const declarations = checker.getSymbolAtLocation(node)?.declarations ?? [];
    for (const declaration of declarations) {
      if (!ts.isImportSpecifier(declaration) || declaration.isTypeOnly || declaration.parent.parent.isTypeOnly) continue;
      const module = declaration.parent.parent.parent.moduleSpecifier;
      if (ts.isStringLiteral(module) && module.text === from) return declaration.propertyName?.text ?? declaration.name.text;
    }
    return undefined;
  };
  const routerObject = (node: ts.Expression): boolean => {
    node = unwrapped(node);
    if (expoImport(node) === "router") return true;
    if (ts.isCallExpression(node) && expoImport(node.expression) === "useRouter") return true;
    for (const declaration of symbol(node)?.declarations ?? []) {
      if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) continue;
      const initializer = unwrapped(declaration.initializer);
      if (ts.isCallExpression(initializer) && expoImport(initializer.expression) === "useRouter") return true;
    }
    return false;
  };
  const primitive = (type: ts.Type): boolean => type.isUnion() ? type.types.every(primitive)
    : Boolean(type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike
      | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.BigIntLike));
  for (const ast of program.getSourceFiles()) {
    const inspectWrites = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
        const destination = symbol(node.name); const origin = rootBinding(unwrapped(node.initializer));
        if (destination && origin) {
          for (const [from, to] of [[destination, origin], [origin, destination]]) {
            const values = referenceAliases.get(from!) ?? new Set<ts.Symbol>(); values.add(to!); referenceAliases.set(from!, values);
          }
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) markMutation(node.left);
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) markMutation(node.operand);
      if (ts.isCallExpression(node)) {
        const member = ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression) ? node.expression : undefined;
        const navigation = member && routerObject(member.expression);
        if (!navigation) {
          if (ts.isPropertyAccessExpression(node.expression)
            && ["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin", "set", "delete", "clear"].includes(node.expression.name.text)) markMutation(node.expression.expression);
          // A referenced object handed to arbitrary code is no longer a proven static constant.
          for (const arg of node.arguments) if (!primitive(checker.getTypeAtLocation(arg))) markMutation(arg);
        }
      }
      ts.forEachChild(node, inspectWrites);
    };
    inspectWrites(ast);
  }
  const pendingMutations = [...mutated];
  for (let index = 0; index < pendingMutations.length; index++) for (const alias of referenceAliases.get(pendingMutations[index]!) ?? []) {
    if (!mutated.has(alias)) { mutated.add(alias); pendingMutations.push(alias); }
  }

  const addEdge = (from: string, to: string, kind: NavigationEdge["kind"], sourceFile: string) => {
    if (from === to) return;
    const edge: NavigationEdge = { from, to, kind, sourceFile, provenance: "source" };
    edges.set(JSON.stringify(edge), edge);
    if (edges.size > 50_000) throw new Error("Source navigation exceeds 50,000 edges");
  };

  for (const surface of routes) {
    let operations = 0;
    const visiting = new Set<ts.Node>();
    const followed = new Set<ts.Symbol>();
    let activeLayout: string | undefined;
    // True while visiting what a <NativeTabs> element receives as children. expo-router registers
    // only the triggers found there (Children.toArray, so arrays flatten and fragments do not);
    // a trigger anywhere else, such as a tab screen or its nested layout, only sets that tab's options.
    let tabChildren = false;
    const params: { [key: string]: Value } = Object.fromEntries(new URLSearchParams(surface.route.split("?")[1]));
    const ownPattern = fileRoute(surface.routeFile, appDir).split("/");
    routePath(surface.route).split("/").forEach((part, index) => {
      const dynamic = /^\[([^\]]+)\]$/.exec(ownPattern[index] ?? "");
      if (dynamic) params[dynamic[1]!] = part;
    });
    const evaluateFunction = (fn: ts.FunctionLikeDeclaration, args: Evaluation[], env: Environment, depth: number): Evaluation => {
      const nested = new Map(env);
      fn.parameters.forEach((parameter, index) => {
        if (ts.isIdentifier(parameter.name)) {
          const binding = symbol(parameter.name);
          if (binding) nested.set(binding, args[index] ?? (parameter.initializer ? evaluate(parameter.initializer, env, depth + 1) : unknown()));
        }
      });
      const body = fn.body;
      if (!body) return unknown();
      if (!ts.isBlock(body)) return evaluate(body, nested, depth + 1);
      const results: Evaluation[] = [];
      const returns = (node: ts.Node): void => {
        if (ts.isReturnStatement(node)) results.push(node.expression ? evaluate(node.expression, nested, depth + 1) : known(undefined));
        else if (!ts.isFunctionLike(node)) ts.forEachChild(node, returns);
      };
      returns(body);
      return results.length ? merge(results) : unknown();
    };
    const evaluate = (input: ts.Expression, env: Environment, depth = 0): Evaluation => {
      if (++operations > MAX_OPERATIONS || depth > 24) return unknown();
      const node = unwrapped(input);
      if (ts.isStringLiteralLike(node)) return known(node.text);
      if (ts.isNumericLiteral(node)) return known(Number(node.text));
      if (node.kind === ts.SyntaxKind.TrueKeyword) return known(true);
      if (node.kind === ts.SyntaxKind.FalseKeyword) return known(false);
      if (node.kind === ts.SyntaxKind.NullKeyword) return known(null);
      if (ts.isIdentifier(node)) {
        if (node.text === "undefined") return known(undefined);
        const binding = symbol(node);
        if (!binding) return unknown();
        if (mutated.has(binding)) return unknown();
        if (env.has(binding)) return env.get(binding)!;
        for (const declaration of binding.declarations ?? []) {
          if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
            if (!ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const)) return unknown();
            return evaluate(declaration.initializer, env, depth + 1);
          }
          if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)
            && ts.isVariableDeclaration(declaration.parent.parent) && declaration.parent.parent.initializer) {
            const object = evaluate(declaration.parent.parent.initializer, env, depth + 1);
            const name = declaration.propertyName?.getText() ?? declaration.name.getText();
            return merge(object.values.map((value) => isObject(value) && name in value ? known(value[name]) : unknown()));
          }
        }
        return unknown();
      }
      if (ts.isArrayLiteralExpression(node)) {
        const entries = node.elements.map((entry) => ts.isSpreadElement(entry) ? unknown() : evaluate(entry as ts.Expression, env, depth + 1));
        if (entries.length > MAX_VALUES || entries.some((entry) => entry.unknown || entry.values.length !== 1)) return unknown();
        return known(entries.map((entry) => entry.values[0]));
      }
      if (ts.isObjectLiteralExpression(node)) {
        const object: { [key: string]: Value } = Object.create(null);
        for (const property of node.properties) {
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return unknown();
          const name = ts.isComputedPropertyName(property.name) ? undefined : property.name.getText().replace(/^['"]|['"]$/g, "");
          if (!name) return unknown();
          const result = evaluate(ts.isPropertyAssignment(property) ? property.initializer : property.name, env, depth + 1);
          object[name] = result.values.length === 1 && !result.unknown ? result.values[0] : UNKNOWN;
        }
        return known(object);
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const target = evaluate(node.expression, env, depth + 1);
        const key = ts.isPropertyAccessExpression(node) ? known(node.name.text) : node.argumentExpression ? evaluate(node.argumentExpression, env, depth + 1) : unknown();
        return merge(target.values.flatMap((value) => key.values.map((name) => {
          if (value !== null && typeof value === "object" && (typeof name === "string" || typeof name === "number")) {
            const record = value as { [key: string]: Value };
            return Object.hasOwn(record, String(name)) ? known(record[String(name)]) : known(undefined);
          }
          return unknown();
        })).concat(target.unknown || key.unknown ? [unknown()] : []));
      }
      if (ts.isTemplateExpression(node)) {
        let values = [node.head.text]; let uncertain = false;
        for (const span of node.templateSpans) {
          const value = evaluate(span.expression, env, depth + 1);
          const scalar = value.values.filter((item): item is string | number => typeof item === "string" || typeof item === "number");
          if (value.unknown || !scalar.length) { scalar.push(WILDCARD); uncertain = true; }
          const combined = values.flatMap((prefix) => scalar.map((part) => `${prefix}${part}${span.literal.text}`));
          if (combined.length > MAX_VALUES) uncertain = true;
          values = combined.slice(0, MAX_VALUES);
        }
        return { values, unknown: uncertain };
      }
      if (ts.isConditionalExpression(node)) {
        const condition = evaluate(node.condition, env, depth + 1);
        if (!condition.unknown && condition.values.length === 1) return evaluate(condition.values[0] ? node.whenTrue : node.whenFalse, env, depth + 1);
        return merge([evaluate(node.whenTrue, env, depth + 1), evaluate(node.whenFalse, env, depth + 1)]);
      }
      if (ts.isBinaryExpression(node)) {
        const left = evaluate(node.left, env, depth + 1); const right = evaluate(node.right, env, depth + 1);
        if (left.unknown || right.unknown) return unknown();
        return merge(left.values.flatMap((a) => right.values.map((b) => {
          switch (node.operatorToken.kind) {
            case ts.SyntaxKind.PlusToken: return typeof a === "number" && typeof b === "number" ? known(a + b) : typeof a === "string" && typeof b === "string" ? known(a + b) : unknown();
            case ts.SyntaxKind.MinusToken: return typeof a === "number" && typeof b === "number" ? known(a - b) : unknown();
            case ts.SyntaxKind.EqualsEqualsEqualsToken: return known(a === b);
            case ts.SyntaxKind.ExclamationEqualsEqualsToken: return known(a !== b);
            case ts.SyntaxKind.LessThanToken: return typeof a === "number" && typeof b === "number" ? known(a < b) : unknown();
            case ts.SyntaxKind.GreaterThanToken: return typeof a === "number" && typeof b === "number" ? known(a > b) : unknown();
            case ts.SyntaxKind.QuestionQuestionToken: return known(a ?? b);
            case ts.SyntaxKind.BarBarToken: return known(a || b);
            default: return unknown();
          }
        })));
      }
      if (ts.isCallExpression(node)) {
        const imported = expoImport(node.expression);
        if (imported === "usePathname") return known(routePath(surface.route));
        if (imported === "useLocalSearchParams" || imported === "useGlobalSearchParams") return known(params);
        if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "findIndex") {
          const array = evaluate(node.expression.expression, env, depth + 1); const predicate = node.arguments[0];
          if (!array.unknown && array.values.length === 1 && Array.isArray(array.values[0])
            && predicate && (ts.isArrowFunction(predicate) || ts.isFunctionExpression(predicate))) {
            let index = 0;
            for (const item of array.values[0]) {
              const result = evaluateFunction(predicate, [known(item), known(index)], env, depth + 1);
              if (result.unknown || result.values.length !== 1) return unknown();
              if (result.values[0]) return known(index);
              index++;
            }
            return known(-1);
          }
        }
        const binding = symbol(node.expression);
        for (const declaration of binding?.declarations ?? []) {
          if (ts.isFunctionDeclaration(declaration)) return evaluateFunction(declaration, node.arguments.map((arg) => evaluate(arg, env, depth + 1)), env, depth + 1);
          if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
            const initializer = unwrapped(declaration.initializer);
            if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return evaluateFunction(initializer, node.arguments.map((arg) => evaluate(arg, env, depth + 1)), env, depth + 1);
          }
          if (ts.isImportSpecifier(declaration) && (declaration.propertyName?.text ?? declaration.name.text) === "useMemo"
            && ts.isStringLiteral(declaration.parent.parent.parent.moduleSpecifier)
            && declaration.parent.parent.parent.moduleSpecifier.text === "react") {
            const callback = node.arguments[0];
            if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return evaluateFunction(callback, [], env, depth + 1);
          }
        }
      }
      return unknown();
    };

    const destinations = (value: Value, source: ts.Node): string[] => {
      let route: string;
      let objectParams: { [key: string]: Value } = {};
      if (typeof value === "string") route = value;
      else if (isObject(value) && typeof value.pathname === "string") {
        route = value.pathname;
        if (isObject(value.params)) objectParams = value.params;
      } else { issue(source, "destination is not a statically resolved route"); return []; }
      if (/^(?:https?:|mailto:|tel:)/i.test(route)) return []; // External links are not app graph edges.
      if (route.startsWith(".") && !route.includes(WILDCARD)) route = posix.join(posix.dirname(routePath(surface.route)), route);
      if (!route.startsWith("/") || route.startsWith("//") || route.includes("\\") || route.includes("#")) {
        issue(source, "destination is not a supported internal route"); return [];
      }
      const rawParts = routePath(route).split("/");
      const explicitGroups = route.split("?")[0]!.split("/").filter((part) => /^\(.*\)$/.test(part));
      const exactPathExists = !route.includes(WILDCARD) && routes.some((candidate) => routePath(candidate.route) === routePath(route));
      const query = new URLSearchParams(route.split("?")[1]);
      for (const [key, value] of Object.entries(objectParams)) {
        query.set(key, typeof value === "string" || typeof value === "number" ? String(value) : WILDCARD);
      }
      const matched = routes.filter((candidate) => {
        const concrete = routePath(candidate.route).split("/");
        const pattern = fileRoute(candidate.routeFile, appDir).split("/");
        if (explicitGroups.some((group) => !candidate.routeFile.split("/").includes(group))) return false;
        if (exactPathExists && routePath(candidate.route) !== routePath(route)) return false;
        if (rawParts.length !== concrete.length) return false;
        for (let index = 0; index < rawParts.length; index++) {
          const part = rawParts[index]!;
          const dynamic = /^\[(?:\.\.\.)?[^\]]+\]$/.test(pattern[index] ?? "");
          if (part.includes(WILDCARD) || /^\[[^\]]+\]$/.test(part)) { if (!dynamic) return false; }
          else if (part !== concrete[index] && !dynamic) return false;
        }
        const targetQuery = new URLSearchParams(candidate.route.split("?")[1]);
        for (const [key, value] of query) {
          if (value.includes(WILDCARD)) continue;
          // An omitted request/history id in a fixture is not evidence for a different route.
          if (targetQuery.has(key) && targetQuery.get(key) !== value) return false;
        }
        return true;
      }).map((candidate) => candidate.id);
      if (!matched.length) issue(source, "destination has no matching declared surface");
      return matched;
    };
    const record = (node: ts.Node, expression: ts.Expression | undefined, kind: NavigationEdge["kind"], env: Environment) => {
      const result = expression ? evaluate(expression, env) : unknown();
      const targets = result.values.flatMap((value) => destinations(value, node));
      for (const target of targets) addEdge(surface.id, target, kind, node.getSourceFile().fileName.slice(1));
      if (result.unknown || !result.values.length || result.values.some((value) => value === UNKNOWN)) issue(node, "runtime-computed destination; source links may be incomplete");
    };
    const resolveRegistration = (node: ts.Node, name: Value): string[] => {
      if (typeof name !== "string" || !name || name.includes("..") || name.startsWith("/")) return [];
      const directory = posix.dirname(activeLayout ?? node.getSourceFile().fileName.slice(1));
      const target = `${directory}/${name}`;
      return routes.filter((candidate) => {
        const group = routeGroupOf(candidate.routeFile);
        return group === target || group === `${target}/index` || group.startsWith(`${target}/`) && name.startsWith("(");
      }).map((candidate) => candidate.id);
    };

    const visit = (node: ts.Node, env: Environment, explicit = false): void => {
      if (++operations > MAX_OPERATIONS || visiting.has(node) || ts.isTypeNode(node)
        || ts.isImportDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
      if (ts.isFunctionDeclaration(node) && !explicit) return;
      if (ts.isVariableDeclaration(node) && node.initializer && !explicit
        && (ts.isArrowFunction(unwrapped(node.initializer)) || ts.isFunctionExpression(unwrapped(node.initializer)))) return;
      visiting.add(node);
      const outerTabChildren = tabChildren;
      try {
        if (ts.isCallExpression(node)) {
          let member: ts.Expression = node.expression;
          if (ts.isIdentifier(member)) {
            for (const declaration of symbol(member)?.declarations ?? []) {
              if (ts.isVariableDeclaration(declaration) && declaration.initializer) member = unwrapped(declaration.initializer);
              else if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)
                && ts.isVariableDeclaration(declaration.parent.parent) && declaration.parent.parent.initializer
                && routerObject(declaration.parent.parent.initializer)) {
                const method = declaration.propertyName?.getText() ?? declaration.name.getText();
                if (["push", "replace", "navigate", "dismissTo"].includes(method)) record(node, node.arguments[0], method as NavigationEdge["kind"], env);
                else if (["back", "dismiss", "dismissAll"].includes(method)) issue(node, `${method} depends on navigation history`, true);
              }
            }
          }
          if ((ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member)) && routerObject(member.expression)) {
            const methods = ts.isPropertyAccessExpression(member) ? known(member.name.text) : member.argumentExpression ? evaluate(member.argumentExpression, env) : unknown();
            for (const method of methods.values) {
              if (typeof method !== "string") continue;
              if (["push", "replace", "navigate", "dismissTo"].includes(method)) record(node, node.arguments[0], method as NavigationEdge["kind"], env);
              else if (["back", "dismiss", "dismissAll"].includes(method)) issue(node, `${method} depends on navigation history`, true);
            }
            if (methods.unknown) issue(node, "runtime-computed router method");
          }
        }
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const method = node.expression.name.text;
          if (method === "map") {
            const callback = node.arguments[0];
            const collection = evaluate(node.expression.expression, env);
            if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && !collection.unknown
              && collection.values.length === 1 && Array.isArray(collection.values[0])) {
              visit(node.expression.expression, env);
              collection.values[0].forEach((value, index) => {
                const nested = new Map(env);
                callback.parameters.forEach((parameter, parameterIndex) => {
                  const binding = symbol(parameter.name);
                  if (binding) nested.set(binding, known(parameterIndex === 0 ? value : index));
                });
                visit(callback.body, nested);
              });
              return;
            }
          }
        }
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const component = expoImport(node.tagName);
          const attribute = (name: string): ts.Expression | undefined => {
            const attr = node.attributes.properties.find((entry): entry is ts.JsxAttribute => ts.isJsxAttribute(entry) && entry.name.getText() === name);
            const value = attr?.initializer;
            return value && ts.isJsxExpression(value) ? value.expression : value && ts.isStringLiteral(value) ? value : undefined;
          };
          if (component === "Link" || component === "Redirect") record(node, attribute("href"), component === "Redirect" ? "redirect" : "push", env);
          // <NativeTabs.Trigger name> (or the NativeTabTrigger export) registers a route only as a child of <NativeTabs>.
          const trigger = outerTabChildren && (ts.isPropertyAccessExpression(node.tagName) && node.tagName.name.text === "Trigger"
            ? expoImport(node.tagName.expression, NATIVE_TABS) === "NativeTabs" : expoImport(node.tagName, NATIVE_TABS) === "NativeTabTrigger");
          if (trigger || ts.isPropertyAccessExpression(node.tagName) && node.tagName.name.text === "Screen") {
            const navigator = trigger ? "NativeTabs" : ts.isPropertyAccessExpression(node.tagName) ? expoImport(node.tagName.expression) : undefined;
            const name = attribute("name"); const names = name ? evaluate(name, env) : unknown();
            const targets = names.values.flatMap((value) => resolveRegistration(node, value));
            if ((navigator === "Tabs" || navigator === "NativeTabs" || navigator === "Stack") && names.unknown) issue(node, "runtime-computed navigator registration");
            if (navigator === "Tabs" || navigator === "NativeTabs") {
              // A tab is hidden only when every value is known to hide it; a partly runtime value may show it.
              let hidden: boolean;
              if (navigator === "Tabs") {
                const setting = attribute("options");
                const configurations = setting ? evaluate(setting, env) : unknown();
                hidden = !configurations.unknown && configurations.values.length > 0
                  && configurations.values.every((value) => isObject(value) && value.href === null);
              } else {
                // A bare `hidden` attribute is true; expo-router hides the trigger when the value is truthy.
                const bare = node.attributes.properties.some((entry) => ts.isJsxAttribute(entry) && entry.name.getText() === "hidden" && !entry.initializer);
                const setting = attribute("hidden");
                const flags = setting ? evaluate(setting, env) : unknown();
                hidden = bare || !flags.unknown && flags.values.length > 0 && flags.values.every((value) => value !== UNKNOWN && Boolean(value));
              }
              if (!hidden && !targets.length && !names.unknown) issue(node, "navigator registration has no matching declared surface");
              // Selecting the current tab is not navigation between its fixture variants.
              if (!hidden && !targets.includes(surface.id)) for (const target of targets) addEdge(surface.id, target, "tab", node.getSourceFile().fileName.slice(1));
            } else if (navigator === "Stack") {
              const setting = attribute("options");
              if (setting && evaluate(setting, env).values.some((value) => isObject(value) && typeof value.presentation === "string" && /modal|formSheet/i.test(value.presentation))) {
                targets.forEach((id) => modalSurfaceIds.add(id));
              }
            }
          }
          // A tag and its props are never navigator children, nor is a component it renders.
          tabChildren = false;
        }
        if (ts.isJsxFragment(node)) tabChildren = false;
        if (ts.isJsxElement(node)) {
          visit(node.openingElement, env);
          // A trigger wrapped in Protected stays a possible registration, as Tabs.Screen does (the guard
          // is not evaluated). expo-router 57's NativeTabs drops such a trigger; its screen filter handles one.
          const tag = node.openingElement.tagName;
          tabChildren = expoImport(tag, NATIVE_TABS) === "NativeTabs"
            || outerTabChildren && ts.isPropertyAccessExpression(tag) && tag.name.text === "Protected";
          for (const child of node.children) visit(child, env);
          return;
        }
        if (ts.isIdentifier(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
          && !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)
          && !(ts.isFunctionDeclaration(node.parent) && node.parent.name === node)
          && !(ts.isParameter(node.parent) && node.parent.name === node)) {
          const binding = symbol(node);
          if (binding && !followed.has(binding) && !env.has(binding)) {
            followed.add(binding);
            for (const declaration of binding.declarations ?? []) {
              if (ts.isFunctionDeclaration(declaration) && declaration.body) visit(declaration.body, env);
              else if (ts.isVariableDeclaration(declaration) && declaration.initializer) visit(declaration.initializer, env);
              else if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)) {
                let parent: ts.Node = declaration;
                while (!ts.isImportDeclaration(parent) && !ts.isSourceFile(parent)) parent = parent.parent;
                if (ts.isImportDeclaration(parent) && ts.isStringLiteral(parent.moduleSpecifier)
                  && /^(?:\.|@\/|~)/.test(parent.moduleSpecifier.text)
                  && !assetFile.test(parent.moduleSpecifier.text)
                  && !resolveModule(parent.moduleSpecifier.text, parent.getSourceFile().fileName)) issue(parent, "local imported code could not be resolved");
              }
            }
          }
        }
        ts.forEachChild(node, (child) => visit(child, env));
      } finally { visiting.delete(node); tabChildren = outerTabChildren; }
    };
    const visitDefault = (file: string) => {
      const ast = program.getSourceFile(`/${file}`);
      if (!ast) { unresolved.add(`Unresolved navigation: ${diagnosticPath(file)}: route source is missing`); return; }
      const module = checker.getSymbolAtLocation(ast);
      const exported = module && checker.getExportsOfModule(module).find((binding) => binding.name === "default");
      const resolved = exported && (exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported);
      if (!resolved?.declarations?.length) { issue(ast, "route has no statically resolved default export"); return; }
      const previousLayout = activeLayout;
      if (/\/_layout\.[jt]sx?$/.test(file)) activeLayout = file;
      for (const declaration of resolved.declarations) visit(declaration, new Map(), true);
      activeLayout = previousLayout;
    };
    visitDefault(surface.routeFile);
    let directory = posix.dirname(surface.routeFile);
    while (directory.startsWith(appDir)) {
      const layout = extensions.map((extension) => `${directory}/_layout${extension}`).find((path) => files.has(path));
      if (layout) visitDefault(layout);
      if (directory === appDir) break;
      directory = posix.dirname(directory);
    }
    // New discoveries retain the actual JSX Redirect / router.replace operation above.
    // Only older explicit single-destination inputs need an extra declaration edge.
    if (surface.kind === "redirect" && !surface.redirectTargets && surface.redirectTo) {
      const ast = program.getSourceFile(`/${surface.routeFile}`);
      if (ast) for (const target of destinations(surface.redirectTo!, ast)) addEdge(surface.id, target, "redirect", surface.routeFile);
    }
    if (operations > MAX_OPERATIONS) unresolved.add(`Unresolved navigation: ${diagnosticPath(surface.routeFile)}: source analysis budget exceeded`);
  }
  return validateNavigationGraph({ contract: "explore.navigation",
    edges: [...edges.values()].sort((a, b) => { const left = JSON.stringify(a); const right = JSON.stringify(b); return left < right ? -1 : left > right ? 1 : 0; }),
    modalSurfaceIds: [...modalSurfaceIds].sort(), unresolved: [...unresolved].sort() }, routes.map((surface) => surface.id));
}
