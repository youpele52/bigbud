import { createHash } from "node:crypto";
import * as ts from "typescript";

/** Rolldown deconflicts colliding top-level names bundle-wide, so an edit anywhere in the bundle
 * can rename an untouched reviewed region: `posix$2` → `posix$1`, or `read$2` → `read` when
 * another chunk frees the name. The region digest therefore hashes a canonical text in which
 * every binding is labelled by what it resolves to (TypeScript's binder, never by spelling):
 *
 * - A binding whose every declaration lies inside the region becomes `$#<k>`, numbered by first
 *   appearance, whether or not its name carries a `$<n>` suffix. Distinct bindings get distinct
 *   labels even when they share a spelling (shadowing), so no two bindings are merged.
 * - A free name keeps its spelling, so a change in what the region refers to, including a free
 *   name captured by a new local, changes the digest. An undeclared global keeps its exact bytes.
 *   A binding declared elsewhere in the file is marked `<name>#`, so it never reads as a global;
 *   when it carries a `$<n>` suffix it becomes `<base>$#<k>`, numbered per base by first
 *   appearance. What that outside declaration holds lives outside the region and is not pinned.
 * - Property keys, export and import names, labels, strings and comments keep their bytes.
 *   Where one identifier is both a key and a binding (`{ a }`, `export { a }`, `import { a }`),
 *   the key is spelled out beside the label (`a:$#0`, `$#0 as a`, `a as $#0`).
 *
 * The canonical text is therefore equal only for regions that are byte-equivalent up to a
 * consistent renaming of their local bindings. A region that declares nothing and refers to no
 * file binding hashes to its raw-text digest. `#` cannot occur in an identifier, so labels never meet raw names. */
const SUFFIXED = /^([A-Za-z_$][\w$]*?)\$(\d+)$/;
const BINDING =
  ts.SymbolFlags.Variable | ts.SymbolFlags.Function | ts.SymbolFlags.Class | ts.SymbolFlags.Alias;
const MEMBER = ts.SymbolFlags.Property | ts.SymbolFlags.Method | ts.SymbolFlags.Accessor;

/** Identifiers that are never a binding: member names, labels and `import.meta`. */
function keyOnly(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (
    ts.isLabeledStatement(parent) ||
    ts.isBreakOrContinueStatement(parent) ||
    ts.isMetaProperty(parent)
  )
    return true;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  if (ts.isImportSpecifier(parent) && parent.propertyName === node) return true;
  if (ts.isExportSpecifier(parent) && parent.name === node && parent.propertyName) return true;
  return (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
    parent.name === node
  );
}

/** How a renamed identifier is spelled when it is also a key: `{ a }`, `export { a }`, ... */
function spell(node: ts.Identifier, label: string): string {
  const parent = node.parent;
  if (ts.isShorthandPropertyAssignment(parent)) return `${node.text}: ${label}`;
  if (ts.isExportSpecifier(parent) && !parent.propertyName) return `${label} as ${node.text}`;
  if (ts.isImportSpecifier(parent) && !parent.propertyName) return `${node.text} as ${label}`;
  if (
    ts.isBindingElement(parent) &&
    !parent.propertyName &&
    !parent.dotDotDotToken &&
    ts.isObjectBindingPattern(parent.parent)
  )
    return `${node.text}: ${label}`;
  return label;
}

/** A binder over the already-parsed tree; built only when a region digest is first needed. */
function makeResolver(tree: ts.SourceFile) {
  const options: ts.CompilerOptions = {
    allowJs: true,
    noLib: true,
    noResolve: true,
    types: [],
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
  };
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === tree.fileName ? tree : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === tree.fileName,
    readFile: () => undefined,
  };
  const checker = ts.createProgram([tree.fileName], options, host).getTypeChecker();
  return (node: ts.Identifier): ts.Symbol | undefined => {
    const parent = node.parent;
    let symbol: ts.Symbol | undefined;
    if (ts.isShorthandPropertyAssignment(parent) && parent.name === node)
      symbol = checker.getShorthandAssignmentValueSymbol(parent);
    else if (ts.isExportSpecifier(parent))
      symbol = checker.getExportSpecifierLocalTargetSymbol(parent);
    else symbol = checker.getSymbolAtLocation(node);
    if (!symbol || !(symbol.flags & BINDING) || symbol.flags & MEMBER) return undefined;
    return symbol;
  };
}

/** The canonical text of `text.slice(start, end)`; see the comment at the top. */
export function makeCanonicalRegion(tree: ts.SourceFile, text: string) {
  let resolve: ReturnType<typeof makeResolver> | undefined;
  return (start: number, end: number) => {
    const resolver = (resolve ??= makeResolver(tree));
    const inside = (declaration: ts.Declaration) => {
      const at = declaration.getStart(tree);
      return declaration.getSourceFile() === tree && at >= start && declaration.end <= end;
    };
    const labels = new Map<ts.Symbol, string>();
    const perBase = new Map<string, number>();
    let local = 0;
    const label = (node: ts.Identifier): string | undefined => {
      if (keyOnly(node)) return undefined;
      const symbol = resolver(node);
      const declarations = symbol?.declarations;
      if (!symbol || !declarations?.length) return undefined;
      const known = labels.get(symbol);
      if (known) return known;
      let next: string | undefined;
      if (declarations.every(inside)) next = `$#${local++}`;
      else {
        const suffixed = SUFFIXED.exec(node.text);
        if (!declarations.every((d) => d.getSourceFile() === tree)) return undefined;
        if (!suffixed) next = `${node.text}#`;
        else {
          const index = perBase.get(suffixed[1]!) ?? 0;
          perBase.set(suffixed[1]!, index + 1);
          next = `${suffixed[1]}$#${index}`;
        }
      }
      labels.set(symbol, next);
      return next;
    };
    let output = "";
    let cursor = start;
    const visit = (node: ts.Node) => {
      if (node.end <= start || node.pos >= end) return;
      if (ts.isIdentifier(node)) {
        const at = node.getStart(tree);
        const renamed = at >= start && node.end <= end ? label(node) : undefined;
        if (renamed !== undefined) {
          output += text.slice(cursor, at) + spell(node, renamed);
          cursor = node.end;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    return output + text.slice(cursor, end);
  };
}

export function makeRegionDigest(tree: ts.SourceFile, text: string) {
  const canonical = makeCanonicalRegion(tree, text);
  const digests = new Map<string, string>();
  return (start: number, end: number) => {
    const key = `${start}:${end}`;
    const known = digests.get(key);
    if (known) return known;
    const digest = createHash("sha256").update(canonical(start, end)).digest("hex");
    digests.set(key, digest);
    return digest;
  };
}
