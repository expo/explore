import { posix } from "node:path";
import ts from "typescript";
import type { SourceRoute } from "../../contracts/source-route.js";
import { sourceRouteId } from "./route-id.js";

type Ref = { file: string; node: ts.Node };
type ImportBinding = { module: string; imported: string };
type Module = { ast: ts.SourceFile; imports: Map<string, ImportBinding> };
type Registration = { name: string; component?: Ref; linking?: Ref; file: string };
type Navigator = { key: string; file: string; name: string; tabs: boolean; screens: Registration[]; initial?: string };
type Instance = { navigator: Navigator; logicalPath: string; parent?: Instance; children: Map<string, Instance | SourceRoute> };
type Edge = { from: string; to: string; kind: "navigate" | "push" | "replace" | "tab" | "redirect"; sourceFile: string; expression?: string };
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export type ReactNavigationOptions = {
  entry?: string;
  parameters?: Record<string, Record<string, string>>;
  platform?: "ios" | "android" | "web";
};

/** Discover registered screens from source. Linking controls reachability, never membership. */
export function discoverReactNavigation(files: Record<string, string>, options: ReactNavigationOptions = {}): {
  routes: SourceRoute[];
  edges: Edge[];
  diagnostics: string[];
} {
  const diagnostics = new Set<string>();
  const modules = new Map<string, Module>();
  const navigators = new Map<string, Navigator>();
  const routes: SourceRoute[] = [];
  const edges: Edge[] = [];
  const contexts = new Map<string, { instance: Instance; registration: Registration }>();
  const platform = options.platform ?? "ios";
  const normalizedFiles = new Map(Object.entries(files).map(([file, source]) => [posix.normalize(file.replaceAll("\\", "/")).replace(/^\.\//, ""), source]));
  const aliases: Array<{ pattern: string; targets: string[]; base: string }> = [];
  for (const [file, source] of [...normalizedFiles].sort(([a], [b]) => compare(a, b))) {
    if (!/(?:^|\/)tsconfig\.json$/.test(file)) continue;
    const parsed = ts.parseConfigFileTextToJson(file, source);
    const config = parsed.config?.compilerOptions;
    if (config?.paths && typeof config.paths === "object") {
      for (const [pattern, targets] of Object.entries(config.paths)) {
        if (Array.isArray(targets) && targets.every((target) => typeof target === "string")) {
          aliases.push({ pattern, targets, base: posix.join(posix.dirname(file), typeof config.baseUrl === "string" ? config.baseUrl : ".") });
        }
      }
    }
  }
  const resolveModule = (file: string, specifier: string): string | undefined => {
    const bases: string[] = [];
    if (specifier.startsWith(".")) bases.push(posix.normalize(posix.join(posix.dirname(file), specifier)));
    else {
      for (const alias of aliases) {
        const [prefix, suffix] = alias.pattern.split("*");
        if (suffix === undefined ? specifier === prefix : specifier.startsWith(prefix!) && specifier.endsWith(suffix)) {
          const replacement = suffix === undefined ? "" : specifier.slice(prefix!.length, specifier.length - suffix.length);
          bases.push(...alias.targets.map((target) => posix.normalize(posix.join(alias.base, target.replace("*", replacement)))));
        }
      }
    }
    for (let base of bases) {
      if (/\.[cm]?jsx?$/.test(base) && !normalizedFiles.has(base)) base = base.replace(/\.[cm]?jsx?$/, "");
      const suffixes = [`.${platform}`, ...(platform === "web" ? [] : [".native"]), ""];
      const candidates = suffixes.flatMap((suffix) => [".tsx", ".ts", ".jsx", ".js", ".mts", ".mjs", ".cts", ".cjs"].map((ext) => base + suffix + ext));
      candidates.push(base, ...suffixes.flatMap((suffix) => [".tsx", ".ts", ".jsx", ".js"].map((ext) => `${base}/index${suffix}${ext}`)));
      const found = candidates.find((candidate) => normalizedFiles.has(candidate));
      if (found) return found;
    }
    return undefined;
  };
  const eligible = (file: string) => /\.[cm]?[jt]sx?$/.test(file)
    && !/(?:^|\/)(?:node_modules|__tests__|__mocks__|tests?|fixtures?|dist|build)\//.test(file)
    && !/\.(?:d|test|spec)\.[cm]?[jt]sx?$/.test(file)
    && !/\.(?:ios|android|web|native)\.[cm]?[jt]sx?$/.test(file.replace(new RegExp(`\\.${platform}(?=\\.)`), "").replace(platform === "web" ? /$^/ : /\.native(?=\.)/, ""));
  const getModule = (file: string): Module | undefined => {
    const cached = modules.get(file);
    if (cached) return cached;
    const source = normalizedFiles.get(file);
    if (source === undefined || !/\.[cm]?[jt]sx?$/.test(file)) return undefined;
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const module: Module = { ast, imports: new Map() };
    modules.set(file, module);
    if ((ast as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) diagnostics.add(`React Navigation source could not be parsed completely: ${file}`);
    for (const statement of ast.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue;
      const clause = statement.importClause;
      if (clause?.name) module.imports.set(clause.name.text, { module: statement.moduleSpecifier.text, imported: "default" });
      const named = clause?.namedBindings;
      if (named && ts.isNamespaceImport(named)) module.imports.set(named.name.text, { module: statement.moduleSpecifier.text, imported: "*" });
      else if (named && ts.isNamedImports(named)) for (const binding of named.elements) {
        if (!binding.isTypeOnly) module.imports.set(binding.name.text, { module: statement.moduleSpecifier.text, imported: binding.propertyName?.text ?? binding.name.text });
      }
    }
    return module;
  };
  const selectedPlatformFile = (file: string): boolean => {
    const stem = posix.basename(file).replace(/\.[cm]?[jt]sx?$/, "").replace(/\.(?:ios|android|web|native)$/, "");
    return resolveModule(file, `./${stem}`) === file;
  };
  let sourcePaths = [...normalizedFiles.keys()].filter(file => eligible(file) && selectedPlatformFile(file)).sort();
  if (options.entry) {
    const entry = posix.normalize(options.entry).replace(/^\.\//, "");
    if (!normalizedFiles.has(entry)) diagnostics.add(`React Navigation entry is missing: ${entry}`);
    const reachable = new Set<string>();
    const visit = (file: string): void => {
      if (reachable.has(file)) return;
      reachable.add(file);
      const module = getModule(file);
      if (!module) return;
      for (const statement of module.ast.statements) {
        if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
          const resolved = resolveModule(file, statement.moduleSpecifier.text);
          if (resolved) visit(resolved);
          else if (statement.moduleSpecifier.text.startsWith(".")) diagnostics.add(`Unresolved React Navigation import: ${file} -> ${statement.moduleSpecifier.text}`);
        }
      }
    };
    visit(entry);
    sourcePaths = [...reachable].filter(eligible).sort();
  }
  for (const file of sourcePaths) getModule(file);
  const key = (ref: Ref) => `${ref.file}:${ref.node.pos}:${ref.node.end}`;
  const unwrap = (node: ts.Node): ts.Node => {
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
    return node;
  };
  const declarations = (scope: ts.Node, name: string): ts.Node | undefined => {
    let found: ts.Node | undefined;
    const visit = (node: ts.Node): void => {
      if (node !== scope && (ts.isFunctionLike(node) || ts.isBlock(node))) {
        if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
        return;
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found = node.initializer ?? node;
      if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === name) found = node;
      ts.forEachChild(node, visit);
    };
    visit(scope);
    return found;
  };
  const lookup = (ref: Ref, name: string): Ref | undefined => {
    for (let scope: ts.Node | undefined = ref.node; scope; scope = scope.parent) {
      if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isFunctionLike(scope)) {
        const found = declarations(scope, name);
        if (found) return { file: ref.file, node: found };
      }
    }
    return undefined;
  };
  const exportRef = (file: string, name: string, seen: Set<string>): Ref | undefined => {
    const marker = `export:${file}:${name}`;
    if (seen.has(marker)) return undefined;
    seen.add(marker);
    const module = getModule(file);
    if (!module) return undefined;
    for (const statement of module.ast.statements) {
      if (name === "default" && ts.isExportAssignment(statement)) return resolve({ file, node: statement.expression }, seen);
      if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        const isDefault = ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
        if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && (isDefault && name === "default" || statement.name?.text === name)) return { file, node: statement };
        if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) return resolve({ file, node: declaration.initializer }, seen);
        }
      }
      if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
        const target = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? resolveModule(file, statement.moduleSpecifier.text) : file;
        if (!target) continue;
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          const binding = statement.exportClause.elements.find((element) => element.name.text === name);
          if (binding) {
            if (target !== file) return exportRef(target, binding.propertyName?.text ?? binding.name.text, seen);
            const local = lookup({ file, node: binding }, binding.propertyName?.text ?? binding.name.text);
            if (local) return resolve(local, seen);
            const imported = module.imports.get(binding.propertyName?.text ?? binding.name.text);
            const importedFile = imported && resolveModule(file, imported.module);
            if (importedFile && imported) return exportRef(importedFile, imported.imported, seen);
          }
        } else if (!statement.exportClause && name !== "default") {
          const candidate = exportRef(target, name, new Set(seen));
          if (candidate) return candidate;
        }
      }
    }
    return undefined;
  };
  const resolve = (input: Ref, seen = new Set<string>()): Ref => {
    const ref = { file: input.file, node: unwrap(input.node) };
    if (seen.size > 80 || seen.has(key(ref))) return ref;
    seen.add(key(ref));
    if (ts.isIdentifier(ref.node)) {
      const local = lookup(ref, ref.node.text);
      if (local && key(local) !== key(ref)) return resolve(local, seen);
      const imported = getModule(ref.file)?.imports.get(ref.node.text);
      const target = imported && resolveModule(ref.file, imported.module);
      if (imported && target && imported.imported !== "*") return exportRef(target, imported.imported, seen) ?? ref;
    } else if (ts.isPropertyAccessExpression(ref.node) || ts.isElementAccessExpression(ref.node)) {
      const expression = ref.node.expression;
      const member = ts.isPropertyAccessExpression(ref.node) ? ref.node.name.text : ref.node.argumentExpression && literal({ file: ref.file, node: ref.node.argumentExpression }, seen);
      if (typeof member !== "string") return ref;
      if (ts.isIdentifier(expression)) {
        const imported = getModule(ref.file)?.imports.get(expression.text);
        const target = imported?.imported === "*" && resolveModule(ref.file, imported.module);
        if (target) return exportRef(target, member, seen) ?? ref;
      }
      const property = properties({ file: ref.file, node: expression }, seen).get(member);
      return property ? resolve(property, seen) : ref;
    }
    return ref;
  };
  const literal = (input: Ref | undefined, seen = new Set<string>()): string | boolean | undefined => {
    if (!input) return undefined;
    const ref = resolve(input, seen);
    if (ts.isStringLiteralLike(ref.node)) return ref.node.text;
    if (ref.node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (ref.node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isNumericLiteral(ref.node)) return ref.node.text;
    if (ts.isBinaryExpression(ref.node) && ref.node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const a = literal({ file: ref.file, node: ref.node.left }, new Set(seen));
      const b = literal({ file: ref.file, node: ref.node.right }, new Set(seen));
      if (typeof a === "string" && typeof b === "string") return a + b;
    }
    return undefined;
  };
  const properties = (input: Ref | undefined, seen = new Set<string>()): Map<string, Ref> => {
    const result = new Map<string, Ref>();
    if (!input || seen.size > 80) return result;
    const ref = resolve(input, seen);
    if (!ts.isObjectLiteralExpression(ref.node)) return result;
    for (const property of ref.node.properties) {
      if (ts.isSpreadAssignment(property)) {
        for (const [name, value] of properties({ file: ref.file, node: property.expression }, new Set(seen))) result.set(name, value);
      } else if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
        const name = ts.isComputedPropertyName(property.name) ? literal({ file: ref.file, node: property.name.expression }, new Set(seen))
          : ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) || ts.isNumericLiteral(property.name) ? property.name.text : undefined;
        if (typeof name === "string") result.set(name, { file: ref.file, node: ts.isPropertyAssignment(property) ? property.initializer : property.name });
      }
    }
    return result;
  };
  const hasUnresolvedFields = (input: Ref, seen = new Set<string>()): boolean => {
    const ref = resolve(input);
    if (seen.has(key(ref)) || !ts.isObjectLiteralExpression(ref.node)) return true;
    seen.add(key(ref));
    return ref.node.properties.some(property => ts.isSpreadAssignment(property)
      ? hasUnresolvedFields({ file: ref.file, node: property.expression }, new Set(seen))
      : property.name && ts.isComputedPropertyName(property.name)
        ? typeof literal({ file: ref.file, node: property.name.expression }) !== "string" : false);
  };
  const importedFunction = (ref: Ref): string | undefined => {
    const node = unwrap(ref.node);
    if (ts.isIdentifier(node)) {
      const imported = getModule(ref.file)?.imports.get(node.text);
      if (imported?.module.startsWith("@react-navigation/")) return imported.imported;
    } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const imported = getModule(ref.file)?.imports.get(node.expression.text);
      if (imported?.module.startsWith("@react-navigation/") && imported.imported === "*") return node.name.text;
    }
    return undefined;
  };
  const factory = (ref: Ref): string | undefined => {
    const node = unwrap(ref.node);
    if (!ts.isCallExpression(node)) return undefined;
    const name = importedFunction({ file: ref.file, node: node.expression });
    return name && /^create\w*Navigator$/.test(name) ? name : undefined;
  };
  const attribute = (file: string, node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string): Ref | undefined => {
    const item = node.attributes.properties.find((property) => ts.isJsxAttribute(property) && property.name.getText() === name);
    if (!item || !ts.isJsxAttribute(item) || !item.initializer) return undefined;
    return { file, node: ts.isJsxExpression(item.initializer) ? item.initializer.expression ?? item.initializer : item.initializer };
  };
  const navByRef = new Map<string, Navigator>();
  for (const file of sourcePaths) {
    const module = getModule(file);
    if (!module) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const ref = { file, node: unwrap(node.initializer) };
        const kind = factory(ref);
        if (kind) {
          const navigator: Navigator = { key: `${file}#${node.name.text}`, file, name: node.name.text, tabs: /Tab|Drawer/.test(kind), screens: [] };
          if (navigators.has(navigator.key)) diagnostics.add(`Ambiguous React Navigation navigator declaration: ${navigator.key}`);
          else { navigators.set(navigator.key, navigator); navByRef.set(key(ref), navigator); }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(module.ast);
  }
  const componentNavigator = (input: Ref | undefined, seen = new Set<string>()): Navigator | undefined => {
    if (!input || seen.size > 80) return undefined;
    const ref = resolve(input);
    if (seen.has(key(ref))) return undefined;
    seen.add(key(ref));
    const direct = navByRef.get(key(ref));
    if (direct) return direct;
    if (ts.isCallExpression(ref.node) && importedFunction({ file: ref.file, node: ref.node.expression }) === "createStaticNavigation") {
      return ref.node.arguments[0] ? componentNavigator({ file: ref.file, node: ref.node.arguments[0] }, seen) : undefined;
    }
    // Component wrappers are followed without evaluating their functions.
    const found = new Set<Navigator>();
    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName;
        if (ts.isPropertyAccessExpression(tag) && tag.name.text === "Navigator") {
          const nav = componentNavigator({ file: ref.file, node: tag.expression }, new Set(seen));
          if (nav) found.add(nav);
        } else if (ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text)) {
          const nav = componentNavigator({ file: ref.file, node: tag }, new Set(seen));
          if (nav) found.add(nav);
        }
      }
      ts.forEachChild(node, visit);
    };
    if (ts.isFunctionLike(ref.node) || ts.isClassDeclaration(ref.node)) visit(ref.node);
    if (found.size === 1) return [...found][0];
    if (found.size > 1) diagnostics.add(`Component renders multiple React Navigation navigators: ${ref.file}`);
    return undefined;
  };
  const addRegistration = (nav: Navigator, registration: Registration): void => {
    if (nav.screens.some((screen) => screen.name === registration.name)) diagnostics.add(`Duplicate React Navigation screen: ${nav.key}/${registration.name}`);
    else nav.screens.push(registration);
  };
  const readStaticScreens = (nav: Navigator, input: Ref | undefined): void => {
    if (!input) return;
    const entries = properties(input);
    if (!entries.size && !ts.isObjectLiteralExpression(resolve(input).node)) diagnostics.add(`Unresolved React Navigation screens: ${nav.key}`);
    const reportUnknown = (input: Ref, seen = new Set<string>()): void => {
      const ref = resolve(input);
      if (seen.has(key(ref))) return;
      seen.add(key(ref));
      if (!ts.isObjectLiteralExpression(ref.node)) { diagnostics.add(`Unresolved React Navigation screens: ${nav.key}`); return; }
      for (const property of ref.node.properties) {
        if (ts.isSpreadAssignment(property)) reportUnknown({ file: ref.file, node: property.expression }, seen);
        else if (property.name && ts.isComputedPropertyName(property.name) && typeof literal({ file: ref.file, node: property.name.expression }) !== "string") {
          diagnostics.add(`Unresolved React Navigation screen name: ${nav.key}: ${property.name.getText()}`);
        }
      }
    };
    reportUnknown(input);
    for (const [name, value] of [...entries].sort(([a], [b]) => compare(a, b))) {
      const fields = properties(value);
      const component = fields.get("screen") ?? value;
      const linking = fields.get("linking");
      addRegistration(nav, { name, component, file: value.file, ...(linking ? { linking } : {}) });
    }
  };
  for (const [refKey, nav] of navByRef) {
    const module = getModule(nav.file)!;
    let call: ts.CallExpression | undefined;
    const find = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && key({ file: nav.file, node }) === refKey) call = node;
      ts.forEachChild(node, find);
    };
    find(module.ast);
    const configRef = call?.arguments[0] ? { file: nav.file, node: call.arguments[0] } : undefined;
    if (configRef && hasUnresolvedFields(configRef)) diagnostics.add(`Unresolved React Navigation navigator configuration: ${nav.key}`);
    const config = properties(configRef);
    const initial = literal(config.get("initialRouteName"));
    if (typeof initial === "string") nav.initial = initial;
    readStaticScreens(nav, config.get("screens"));
    const groups = config.get("groups");
    if (groups && hasUnresolvedFields(groups)) diagnostics.add(`Unresolved React Navigation groups: ${nav.key}`);
    for (const group of properties(groups).values()) {
      if (hasUnresolvedFields(group)) diagnostics.add(`Unresolved React Navigation group configuration: ${nav.key}`);
      readStaticScreens(nav, properties(group).get("screens"));
    }
  }
  const linkingConfigs: Ref[] = [];
  for (const file of sourcePaths) {
    const module = getModule(file)!;
    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const linking = attribute(file, node, "linking");
        const tagRef = resolve({ file, node: node.tagName });
        const staticNavigation = ts.isCallExpression(tagRef.node) && importedFunction({ file: tagRef.file, node: tagRef.node.expression }) === "createStaticNavigation";
        if (linking && (importedFunction({ file, node: node.tagName }) === "NavigationContainer" || staticNavigation)) linkingConfigs.push(linking);
        if (ts.isPropertyAccessExpression(node.tagName)) {
          const nav = componentNavigator({ file, node: node.tagName.expression });
          if (nav && node.tagName.name.text === "Navigator") {
            const initial = literal(attribute(file, node, "initialRouteName"));
            if (typeof initial === "string") nav.initial = initial;
          }
          if (nav && node.tagName.name.text === "Screen") {
            const name = literal(attribute(file, node, "name"));
            if (typeof name !== "string" || !name) diagnostics.add(`Unresolved React Navigation screen name: ${file}: ${node.tagName.getText()}`);
            else {
              let component = attribute(file, node, "component");
              const getter = attribute(file, node, "getComponent");
              if (!component && getter) {
                const resolved = resolve(getter);
                if (ts.isArrowFunction(resolved.node) && !ts.isBlock(resolved.node.body)) component = { file: resolved.file, node: resolved.node.body };
              }
              if (!component && ts.isJsxOpeningElement(node) && ts.isJsxElement(node.parent)) {
                const child = node.parent.children.find((child) => ts.isJsxExpression(child) && child.expression);
                if (child && ts.isJsxExpression(child) && child.expression) component = { file, node: child.expression };
              }
              if (!component) diagnostics.add(`Unresolved React Navigation screen component: ${nav.key}/${name}`);
              addRegistration(nav, { name, file, ...(component ? { component } : {}) });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(module.ast);
  }
  const nested = new Set<string>();
  for (const nav of navigators.values()) for (const screen of nav.screens) {
    const child = componentNavigator(screen.component);
    if (child) nested.add(child.key);
  }
  let roots = [...navigators.values()].filter((nav) => !nested.has(nav.key)).sort((a, b) => compare(a.key, b.key));
  if (navigators.size && !roots.length) {
    diagnostics.add("React Navigation navigator hierarchy contains a cycle");
    roots = [...navigators.values()].sort((a, b) => compare(a.key, b.key));
  }
  if (!navigators.size) diagnostics.add("No statically resolvable React Navigation navigator declarations found");
  if (linkingConfigs.length > 1) diagnostics.add("Multiple React Navigation linking configurations; ambiguous paths remain unresolved");
  for (const linking of linkingConfigs) {
    const enabled = literal(properties(linking).get("enabled"));
    if (enabled === "auto") diagnostics.add("React Navigation automatic linking requires explicit statically resolvable paths for capture");
  }
  const linkingDisabled = linkingConfigs.length === 1 && literal(properties(linkingConfigs[0]).get("enabled")) === false;
  const rootLinking = linkingConfigs.length === 1 && !linkingDisabled
    ? properties(properties(linkingConfigs[0]).get("config")) : new Map<string, Ref>();
  const linkingScreens = properties(rootLinking.get("screens"));
  const rootPrefix = literal(rootLinking.get("path"));
  const dependencies = (start: string): string[] => {
    const visited = new Set<string>();
    const visit = (file: string): void => {
      if (visited.has(file)) return;
      visited.add(file);
      for (const imported of getModule(file)?.imports.values() ?? []) {
        const target = resolveModule(file, imported.module);
        if (target) visit(target);
      }
    };
    visit(start);
    return [...visited].sort();
  };
  const instances: Instance[] = [];
  const instantiate = (nav: Navigator, logicalPath: string, linking: Map<string, Ref>, prefix: string, parent?: Instance, stack = new Set<string>()): Instance => {
    const instance: Instance = { navigator: nav, logicalPath, children: new Map(), ...(parent ? { parent } : {}) };
    instances.push(instance);
    if (stack.has(nav.key)) { diagnostics.add(`Cyclic React Navigation nesting: ${logicalPath}`); return instance; }
    const nextStack = new Set(stack).add(nav.key);
    for (const screen of [...nav.screens].sort((a, b) => compare(a.name, b.name))) {
      const screenPath = `${logicalPath}/${encodeURIComponent(screen.name)}`;
      const id = sourceRouteId("react-navigation", screenPath);
      const config = linkingDisabled ? undefined : linking.get(screen.name) ?? screen.linking;
      const fields = properties(config);
      const literalConfig = literal(config);
      const rawPath = typeof literalConfig === "string" ? literalConfig : literal(fields.get("path"));
      const pathPrefix = literal(fields.get("exact")) === true ? "" : prefix;
      const combined = typeof rawPath === "string" ? `${pathPrefix}/${rawPath}`.replace(/\/+/g, "/") : prefix;
      const child = componentNavigator(screen.component);
      if (child) {
        instance.children.set(screen.name, instantiate(child, screenPath, properties(fields.get("screens")), combined, instance, nextStack));
        continue;
      }
      const component = screen.component ? resolve(screen.component) : undefined;
      if (component && !ts.isFunctionLike(component.node) && !ts.isClassDeclaration(component.node)) {
        diagnostics.add(`Unresolved React Navigation screen component: ${screenPath}`);
      }
      const routeFile = component?.file ?? screen.file;
      const contextFiles = new Set([nav.file, screen.file]);
      for (let ancestor = parent; ancestor; ancestor = ancestor.parent) contextFiles.add(ancestor.navigator.file);
      if (config) { contextFiles.add(config.file); contextFiles.add(resolve(config).file); }
      let path: string | null = typeof rawPath === "string" ? combined.replace(/\/$/, "") || "/" : null;
      const parameters: Record<string, string> = {};
      const pathParameters: NonNullable<SourceRoute["pathParameters"]> = Object.create(null);
      for (const match of combined.matchAll(/:([A-Za-z0-9_]+)(\([^)]*\))?(\?)?/g)) {
        const name = match[1]!;
        if (pathParameters[name] !== "required") pathParameters[name] = match[3] ? "optional" : "required";
      }
      if (path !== null) {
        let unresolved = false;
        path = path.replace(/:([A-Za-z0-9_]+)(\([^)]*\))?(\?)?/g, (_match, name: string, _pattern: string | undefined, optional: string | undefined) => {
          const value = options.parameters?.[id]?.[name] ?? options.parameters?.[screenPath]?.[name] ?? options.parameters?.[combined]?.[name] ?? options.parameters?.[screen.name]?.[name];
          if (value === undefined) { if (!optional) unresolved = true; return ""; }
          parameters[name] = value;
          return encodeURIComponent(value);
        });
        if (unresolved || path.includes("*")) {
          diagnostics.add(`Unresolved React Navigation linking parameters: ${screenPath}`);
          path = null;
        } else path = path.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
      }
      const route: SourceRoute = {
        id, kind: "screen", route: screen.name, routeFile,
        sourceFiles: [...new Set([...dependencies(routeFile), ...contextFiles])].sort(),
        variant: "default", title: screen.name, path,
        ...(Object.keys(parameters).length ? { parameters } : {}),
        ...(Object.keys(pathParameters).length ? { pathParameters: Object.fromEntries(Object.entries(pathParameters).sort(([a], [b]) => compare(a, b))) } : {}),
        provider: "react-navigation", logicalPath: screenPath,
      };
      routes.push(route);
      contexts.set(route.id, { instance, registration: screen });
      instance.children.set(screen.name, route);
    }
    return instance;
  };
  for (const root of roots) instantiate(root, root.key, linkingScreens, typeof rootPrefix === "string" ? `/${rootPrefix}` : "");
  const descend = (target: Instance | SourceRoute, nestedNames: string[], unresolvedParams = false): SourceRoute | undefined => {
    if ("id" in target) return nestedNames.length ? undefined : target;
    if (!nestedNames.length && unresolvedParams) return undefined;
    const name = nestedNames[0] ?? target.navigator.initial;
    if (!name) return target.children.size === 1 ? descend([...target.children.values()][0]!, []) : undefined;
    const child = target.children.get(name);
    return child ? descend(child, nestedNames.slice(1), unresolvedParams) : undefined;
  };
  const targetFor = (instance: Instance, name: string, nestedNames: string[], unresolvedParams = false): SourceRoute | undefined => {
    for (let scope: Instance | undefined = instance; scope; scope = scope.parent) {
      const target = scope.children.get(name);
      if (target) return descend(target, nestedNames, unresolvedParams);
    }
    return undefined;
  };
  for (const route of routes) {
    const context = contexts.get(route.id)!;
    const visited = new Set<string>();
    const inspect = (input: Ref): void => {
      const ref = resolve(input);
      if (visited.has(key(ref))) return;
      visited.add(key(ref));
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && /^(?:navigate|push|replace|jumpTo)$/.test(node.expression.name.text)) {
          const receiver = node.expression.expression;
          const receiverRef = resolve({ file: ref.file, node: receiver });
          const receiverName = ts.isIdentifier(receiver) ? receiver.text : "";
          const isHook = ts.isCallExpression(receiverRef.node) && importedFunction({ file: receiverRef.file, node: receiverRef.node.expression }) === "useNavigation";
          const isParameter = ts.isParameter(receiverRef.node) || ts.isIdentifier(receiver) && !lookup({ file: ref.file, node: receiver }, receiver.text);
          const isPropsNavigation = ts.isPropertyAccessExpression(receiver) && receiver.name.text === "navigation";
          if (isHook || isParameter && /^(?:navigation|nav)$/.test(receiverName) || isPropsNavigation) {
            const argument = node.arguments[0] ? { file: ref.file, node: node.arguments[0] } : undefined;
            const argumentFields = properties(argument);
            const name = literal(argumentFields.get("name") ?? argument);
            const nestedNames: string[] = [];
            let unresolvedScreen = false;
            let unresolvedParams = false;
            let params = argumentFields.get("params") ?? (node.arguments[1] ? { file: ref.file, node: node.arguments[1] } : undefined);
            for (let count = 0; params && count < 20; count++) {
              if (hasUnresolvedFields(params)) { unresolvedParams = true; break; }
              const fields = properties(params);
              const screen = fields.get("screen");
              if (!screen) break;
              const nestedName = literal(screen);
              if (typeof nestedName !== "string") { unresolvedScreen = true; break; }
              nestedNames.push(nestedName);
              params = fields.get("params");
            }
            const target = typeof name === "string" && !unresolvedScreen ? targetFor(context.instance, name, nestedNames, unresolvedParams) : undefined;
            if (target) edges.push({ from: route.id, to: target.id, kind: node.expression.name.text === "jumpTo" ? "tab" : node.expression.name.text as "navigate" | "push" | "replace", sourceFile: ref.file, expression: node.getText(getModule(ref.file)!.ast) });
            else diagnostics.add(`Unresolved React Navigation destination: ${route.logicalPath}: ${node.getText(getModule(ref.file)!.ast)}`);
          }
        }
        if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName) && /^[A-Z]/.test(node.tagName.text)) {
          const component = resolve({ file: ref.file, node: node.tagName });
          if (ts.isFunctionLike(component.node) || ts.isClassDeclaration(component.node)) inspect(component);
        }
        ts.forEachChild(node, visit);
      };
      visit(ref.node);
    };
    if (context.registration.component) inspect(context.registration.component);
  }
  for (const instance of instances) {
    if (!instance.navigator.tabs) continue;
    const targets = [...instance.children.values()].flatMap((child) => { const route = descend(child, []); return route ? [route] : []; });
    for (const from of targets) for (const to of targets) if (from.id !== to.id) edges.push({ from: from.id, to: to.id, kind: "tab", sourceFile: instance.navigator.file });
  }
  const uniqueEdges = new Map(edges.map((edge) => [`${edge.from}\0${edge.to}\0${edge.kind}\0${edge.sourceFile}\0${edge.expression ?? ""}`, edge]));
  return {
    routes: routes.sort((a, b) => compare(a.id, b.id)),
    edges: [...uniqueEdges].sort(([a], [b]) => compare(a, b)).map(([, edge]) => edge),
    diagnostics: [...diagnostics].sort(),
  };
}
