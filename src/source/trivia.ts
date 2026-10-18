import ts from "typescript";

const code = /\.([cm]?[jt]sx?)$/;
/** Comments a compiler or bundler reads: JSX pragmas, Flow, pure annotations, Fast Refresh, Haste names and import hints. */
const directive = /[@#]\s*(?:jsx\w*|flow|noflow|__[A-Z_]+__|refresh|providesModule)\b[^\r\n*]*|webpack[A-Z]\w*\s*:[^\r\n*]*|@vite-ignore/g;

function scriptKind(path: string): ts.ScriptKind {
  const extension = code.exec(path)?.[1] ?? "";
  if (extension === "tsx") return ts.ScriptKind.TSX;
  if (extension.endsWith("ts")) return ts.ScriptKind.TS;
  if (extension === "jsx") return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

/**
 * JSX text as the JSX transform keeps it (Babel's `cleanJSXElementLiteralChild`): each line is trimmed where it meets a
 * line break, blank lines are dropped and the rest are joined by a space. Space within a line is kept, and so is a tab.
 */
function jsxText(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  let last = 0;
  lines.forEach((line, index) => { if (/[^ \t]/.test(line)) last = index; });
  let text = "";
  lines.forEach((line, index) => {
    let trimmed = index > 0 ? line.replace(/^[ \t]+/, "") : line;
    if (index < lines.length - 1) trimmed = trimmed.replace(/[ \t]+$/, "");
    if (trimmed) text += index === last ? trimmed : `${trimmed} `;
  });
  return text;
}

/**
 * The program a file compiles to, in order: its syntax tree's nodes and tokens, JSX text as the transform keeps it, and
 * any directive comment. Other comments and the whitespace between tokens are not part of it. The tree keeps a line
 * break that changes the program (`return` then a value on the next line), and drops one that does not.
 */
function tokens(path: string, text: string): string[] | undefined {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, scriptKind(path));
  const { parseDiagnostics } = file as unknown as { parseDiagnostics?: unknown[] };
  if (!parseDiagnostics || parseDiagnostics.length > 0) return undefined;
  const out: string[] = [];
  const directives = (trivia: string): void => {
    for (const [match] of trivia.matchAll(directive)) out.push(`directive:${match.replace(/\s+/g, " ").trim()}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxExpression(node) && !node.expression) return directives(text.slice(node.pos, node.end)); // `{/* a comment */}` compiles to nothing
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return; // a comment the parser attaches, read below as trivia
    if (node.kind === ts.SyntaxKind.JsxText) {
      const value = jsxText(text.slice(node.pos, node.end));
      if (value) out.push(`${node.kind}:${value}`);
      return;
    }
    if (node.getChildCount(file) === 0) {
      directives(text.slice(node.pos, node.getStart(file)));
      if (node.kind !== ts.SyntaxKind.EndOfFileToken) out.push(`${node.kind}:${node.getText(file)}`);
      return;
    }
    out.push(`${node.kind}(`);
    node.getChildren(file).forEach(visit);
    out.push(")");
  };
  visit(file);
  return out;
}

/**
 * Whether two versions of a JavaScript or TypeScript file compile to the same program: the same syntax tree with the
 * same tokens, so only comments, blank lines, indentation or line endings differ. Such an edit cannot change what a
 * screen renders, so the planner does not treat it as a change to the files that import it. JSX text keeps the
 * whitespace the transform keeps (a space inside a `<Text>` renders), a comment a compiler reads (`@jsx`, `#__PURE__`)
 * counts, a file that does not parse is never called the same, and neither are two identical texts: a diff entry a
 * caller supplies for them is theirs to explain (a mode change, a fixture).
 */
export function sameCodeIgnoringTrivia(path: string, base: string | undefined, head: string | undefined): boolean {
  if (base === undefined || head === undefined || !code.test(path)) return false;
  if (base === head) return false;
  const before = tokens(path, base);
  const after = before && tokens(path, head);
  return Boolean(before && after && before.length === after.length && before.every((token, index) => token === after[index]));
}
