import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const srcDir = join(repo, "src");
const contractsDir = join(srcDir, "contracts");

function walk(directory, extensions) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path, extensions);
    return extensions.some((extension) => entry.name.endsWith(extension)) ? [path] : [];
  });
}

const display = (path) => relative(repo, path).split(sep).join("/");

function parse(file) {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, kind);
}

const isImportMetaUrl = (node) => ts.isPropertyAccessExpression(node) && node.name.text === "url"
  && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword;
const isImportMetaGlob = (node) => ts.isPropertyAccessExpression(node) && node.name.text === "glob"
  && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword;

/**
 * Every module reference in a file, with whether TypeScript erases it. A template-literal import()
 * gives its static head plus "*". An import() whose target has no static text gives a null specifier.
 * Vite also bundles import.meta.glob() patterns and new URL(<relative>, import.meta.url) files.
 */
function moduleReferences(file) {
  const source = parse(file);
  const references = [];
  const add = (node, specifier, typeOnly) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    references.push({ specifier, typeOnly, line: line + 1 });
  };
  const addPatterns = (node, argument) => {
    const patterns = argument && ts.isArrayLiteralExpression(argument) ? argument.elements : [argument];
    for (const pattern of patterns) {
      if (pattern && ts.isStringLiteralLike(pattern)) add(node, pattern.text.replace(/^!/, ""), false);
      else add(node, null, false);
    }
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly = Boolean(clause) && (clause.isTypeOnly || (!clause.name && bindings !== undefined
        && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly)));
      add(node, node.moduleSpecifier.text, typeOnly);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      const typeOnly = node.isTypeOnly || (clause !== undefined && ts.isNamedExports(clause)
        && clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly));
      add(node, node.moduleSpecifier.text, typeOnly);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) add(node, argument.text, false);
      else if (argument && ts.isTemplateExpression(argument)) add(node, `${argument.head.text}*`, false);
      else add(node, null, false);
    } else if (ts.isCallExpression(node) && isImportMetaGlob(node.expression)) {
      addPatterns(node, node.arguments[0]);
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL"
      && node.arguments?.length === 2 && isImportMetaUrl(node.arguments[1])) {
      const argument = node.arguments[0];
      if (ts.isStringLiteralLike(argument)) add(node, argument.text, false);
      else if (ts.isTemplateExpression(argument)) add(node, `${argument.head.text}*`, false);
      else add(node, null, false);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteral(node.moduleReference.expression)) {
      add(node, node.moduleReference.expression.text, node.isTypeOnly);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

const within = (parent, path) => {
  const rest = relative(parent, path);
  return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
};
const insideSrc = (target) => target !== srcDir && within(srcDir, target);
const isContract = (target) => target !== contractsDir && within(contractsDir, target);
const isPublicTypes = (target) => /^types(?:\.(?:ts|js))?$/.test(relative(srcDir, target));
/** The folder that a wildcard target (a glob, or a template import's head plus "*") can reach, or undefined. */
const wildcardBase = (target) => {
  const wildcard = target.search(/[*?{[]/);
  return wildcard === -1 ? undefined : dirname(`${target.slice(0, wildcard)}x`);
};
/** Whether a target can reach a src file other than contracts and types.ts. */
const reachesPrivateSrc = (target) => {
  const base = wildcardBase(target);
  if (base === undefined) return insideSrc(target) && !isContract(target) && !isPublicTypes(target);
  return !within(contractsDir, base) && (within(base, srcDir) || within(srcDir, base));
};
/** Whether every file that a target can reach is in contracts or is types.ts. */
const staysInContracts = (target) => {
  const base = wildcardBase(target);
  return base === undefined ? isContract(target) || isPublicTypes(target) : within(contractsDir, base);
};

test("the Viewer imports src only through contracts and types", () => {
  const violations = [];
  for (const file of walk(join(repo, "viewer", "src"), [".ts", ".tsx"])) {
    for (const reference of moduleReferences(file)) {
      if (!reference.specifier?.startsWith(".")) continue;
      const target = resolve(dirname(file), reference.specifier);
      if (reachesPrivateSrc(target)) violations.push(`${display(file)}:${reference.line} imports ${display(target)}`);
    }
  }
  assert.deepEqual(violations, [], "viewer/src may import src only from src/contracts/ or src/types.ts."
    + " Move the shared module into src/contracts/ or keep it out of the Viewer:\n" + violations.join("\n"));
});

const NODE_LOADERS = new Set(["require", "createRequire", "getBuiltinModule"]);

test("contracts stay browser-safe", () => {
  const violations = [];
  for (const file of walk(contractsDir, [".ts", ".tsx"])) {
    const source = parse(file);
    const at = (node) => `${display(file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
    const visit = (node) => {
      if (ts.isIdentifier(node) && NODE_LOADERS.has(node.text)) violations.push(`${at(node)} uses ${node.text}`);
      if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
        && NODE_LOADERS.has(node.argumentExpression.text)) {
        violations.push(`${at(node)} uses ${node.argumentExpression.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const reference of moduleReferences(file)) {
      if (reference.specifier === null) {
        violations.push(`${display(file)}:${reference.line} imports a module with no static path`);
      } else if (reference.specifier.startsWith("node:")) {
        violations.push(`${display(file)}:${reference.line} imports ${reference.specifier}`);
      } else if (!reference.typeOnly) {
        const target = reference.specifier.startsWith(".") ? resolve(dirname(file), reference.specifier) : undefined;
        if (!target || !staysInContracts(target)) {
          violations.push(`${display(file)}:${reference.line} value-imports ${target ? display(target) : reference.specifier}`);
        }
      }
    }
  }
  assert.deepEqual(violations, [], "src/contracts/ runs in the browser. It may not use node: modules (also not type-only),"
    + " require, createRequire or process.getBuiltinModule, and its value imports must stay inside src/contracts/ or src/types.ts"
    + " (other type-only imports may point anywhere):\n" + violations.join("\n"));
});

test("file names do not repeat their folder", () => {
  const violations = [];
  for (const file of walk(srcDir, [".ts"])) {
    const name = basename(file, ".ts");
    for (let folder = dirname(file); folder !== srcDir; folder = dirname(folder)) {
      const folderName = basename(folder);
      if (name === folderName || name.startsWith(`${folderName}-`)) {
        violations.push(`${display(file)} repeats the folder name "${folderName}"`);
      }
    }
  }
  assert.deepEqual(violations, [], "A file name must not repeat its folder or a parent folder"
    + " (src/config/setup.ts, not src/config/config-setup.ts or src/config/config.ts):\n" + violations.join("\n"));
});
