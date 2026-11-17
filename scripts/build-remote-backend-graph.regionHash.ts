import { createHash } from "node:crypto";
import * as ts from "typescript";

/** Rolldown deconflicts colliding top-level names bundle-wide with `$<n>` suffixes, so an edit
 * anywhere in the bundle can rename an untouched reviewed region (`posix$2` → `posix$1`). The
 * region digest therefore hashes a canonical text: each suffixed binding name is renumbered by
 * its first appearance in the region. This is a consistent renaming of bindings only, so the
 * region's code is unchanged: what a free name is bound to always lived outside the region and
 * was never pinned. Distinct names stay distinct, and everything that is not a binding (property
 * keys, shorthand object keys, export names, labels, strings, comments, undeclared globals)
 * keeps its exact bytes. A region with no suffixed binding hashes to its raw-text digest. */
const SUFFIXED = /^([A-Za-z_$][\w$]*?)\$(\d+)$/;

function declaredName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    ((ts.isVariableDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isParameter(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent)) &&
      parent.name === node) ||
    (ts.isBindingElement(parent) && parent.name === node) ||
    (ts.isImportSpecifier(parent) && parent.name === node)
  );
}

/** Identifiers whose spelling is observable beyond binding resolution keep their bytes. */
function bindingReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (
    ts.isShorthandPropertyAssignment(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isLabeledStatement(parent) ||
    ts.isBreakOrContinueStatement(parent) ||
    ts.isMetaProperty(parent)
  )
    return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (ts.isImportSpecifier(parent) && parent.propertyName === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
    parent.name === node
  )
    return false;
  return true;
}

export function makeRegionDigest(tree: ts.SourceFile, text: string) {
  let declared: Set<string> | undefined;
  const declarations = () => {
    if (declared) return declared;
    const names = new Set<string>();
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && SUFFIXED.test(node.text) && declaredName(node))
        names.add(node.text);
      ts.forEachChild(node, visit);
    };
    visit(tree);
    return (declared = names);
  };
  const digests = new Map<string, string>();
  return (start: number, end: number) => {
    const key = `${start}:${end}`;
    const known = digests.get(key);
    if (known) return known;
    const names = declarations();
    const occurrences: { start: number; end: number; name: string }[] = [];
    const visit = (node: ts.Node) => {
      if (node.end <= start || node.pos >= end) return;
      if (
        ts.isIdentifier(node) &&
        names.has(node.text) &&
        node.getStart(tree) >= start &&
        node.end <= end &&
        bindingReference(node)
      )
        occurrences.push({ start: node.getStart(tree), end: node.end, name: node.text });
      ts.forEachChild(node, visit);
    };
    visit(tree);
    occurrences.sort((a, b) => a.start - b.start);
    const canonical = new Map<string, string>();
    const perBase = new Map<string, number>();
    let output = "";
    let cursor = start;
    for (const occurrence of occurrences) {
      let replacement = canonical.get(occurrence.name);
      if (!replacement) {
        const base = SUFFIXED.exec(occurrence.name)![1]!;
        const index = perBase.get(base) ?? 0;
        perBase.set(base, index + 1);
        // `#` cannot occur in an identifier here, so canonical names never meet raw ones.
        replacement = `${base}$#${index}`;
        canonical.set(occurrence.name, replacement);
      }
      output += text.slice(cursor, occurrence.start) + replacement;
      cursor = occurrence.end;
    }
    output += text.slice(cursor, end);
    const digest = createHash("sha256").update(output).digest("hex");
    digests.set(key, digest);
    return digest;
  };
}
