import ts from "typescript";

const code = /\.([cm]?[jt]sx?)$/;

function scriptKind(path: string): ts.ScriptKind {
  const extension = code.exec(path)?.[1] ?? "";
  if (extension === "tsx") return ts.ScriptKind.TSX;
  if (extension.endsWith("ts")) return ts.ScriptKind.TS;
  if (extension === "jsx") return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

/** Every token of a file in order, as the compiler sees it: comments and the whitespace between tokens are not part of any. */
function tokens(path: string, text: string): string[] | undefined {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, scriptKind(path));
  const { parseDiagnostics } = file as unknown as { parseDiagnostics?: unknown[] };
  if (!parseDiagnostics || parseDiagnostics.length > 0) return undefined;
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxExpression(node) && !node.expression) return; // `{/* a comment */}` compiles to nothing
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return; // a comment the parser attaches
    if (node.getChildCount(file) === 0) {
      if (node.kind !== ts.SyntaxKind.EndOfFileToken) out.push(`${node.kind}:${node.getText(file)}`);
      return;
    }
    node.getChildren(file).forEach(visit);
  };
  visit(file);
  return out;
}

/**
 * Whether two versions of a JavaScript or TypeScript file compile to the same program: the same tokens in the same
 * order, so only comments, blank lines, indentation or line endings differ. Such an edit cannot change what a screen
 * renders, so the planner does not treat it as a change to the files that import it. JSX text keeps its whitespace
 * (it is a token), a file that does not parse is never called the same, and neither are two identical texts: a diff
 * entry a caller supplies for them is theirs to explain (a mode change, a fixture).
 */
export function sameCodeIgnoringTrivia(path: string, base: string | undefined, head: string | undefined): boolean {
  if (base === undefined || head === undefined || !code.test(path)) return false;
  if (base === head) return false;
  const before = tokens(path, base);
  const after = before && tokens(path, head);
  return Boolean(before && after && before.length === after.length && before.every((token, index) => token === after[index]));
}
