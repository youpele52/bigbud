import { createHash } from "node:crypto";
import * as ts from "typescript";
import { makeRegionDigest } from "./build-remote-backend-graph.regionHash.ts";

/** Static dependency facts for one graph module. Parsing never executes graph code. */
export type GraphEdgeKind =
  | "static"
  | "dynamic"
  | "require"
  | "require-resolve"
  | "resolve"
  | "url";
export interface GraphEdge {
  readonly specifier: string;
  readonly kind: GraphEdgeKind;
  /** True when the edge runs while the importing module evaluates (static import/export or a
   * module-scope require). Dynamic imports and calls nested in functions are not eager. */
  readonly eager: boolean;
}
export type LoaderSiteKind =
  | "create-require-variable"
  | "non-literal-require"
  | "non-literal-import"
  | "native-loader"
  | "generated-code";
export interface LoaderSite {
  readonly kind: LoaderSiteKind;
  /** Rolldown `//#region` source marker, or the graph path for an unbundled file. */
  readonly member: string;
  /** SHA-256 of the enclosing region's canonical text (consistent binding renames are
   * normalised; see `build-remote-backend-graph.regionHash.ts`), or of the whole file. */
  readonly sha256: string;
  readonly excerpt: string;
}
export interface GraphModule {
  readonly path: string;
  readonly edges: ReadonlyArray<GraphEdge>;
  readonly sites: ReadonlyArray<LoaderSite>;
}

const requireCall = /(?:^|_)require\d*$/;
const createRequireName = /(?:^|\.)createRequire(?:\$\d+)?$/;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Bundle markers keep only the package-relative path, never the build host's store layout. */
export function normalizeRegionMarker(marker: string) {
  const index = marker.lastIndexOf("node_modules/");
  return (index >= 0 ? marker.slice(index + "node_modules/".length) : marker).replace(
    /^(?:\.\.\/)+/,
    "",
  );
}

function regions(text: string) {
  const found: { start: number; end: number; marker: string }[] = [];
  const open: { start: number; marker: string }[] = [];
  for (const match of text.matchAll(/^\/\/#(region|endregion)(?: (.*))?$/gm)) {
    if (match[1] === "region") open.push({ start: match.index, marker: match[2] ?? "" });
    else {
      const last = open.pop();
      if (last)
        found.push({ start: last.start, end: match.index + match[0].length, marker: last.marker });
    }
  }
  return found;
}

/** Parse one module. Syntax errors are refused before any dependency fact is trusted. */
export function parseGraphModule(path: string, text: string): GraphModule {
  const parsed = ts.transpileModule(text, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: {
      allowJs: true,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.Latest,
    },
  });
  if (parsed.diagnostics?.some((d) => d.category === ts.DiagnosticCategory.Error))
    throw new Error(`Executable graph contains invalid JavaScript syntax in ${path}.`);
  const tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const spans = regions(text);
  const regionDigest = makeRegionDigest(tree, text);
  const edges: GraphEdge[] = [];
  const sites: LoaderSite[] = [];
  const requireAliases = new Set(["require"]);
  const createRequireAliases = new Set<string>();
  let fileHash: string | undefined;
  const site = (kind: LoaderSiteKind, node: ts.Node) => {
    const at = node.getStart(tree);
    const region = spans
      .filter((span) => span.start <= at && at < span.end)
      .toSorted((a, b) => b.start - a.start)[0];
    sites.push({
      kind,
      member: region ? normalizeRegionMarker(region.marker) : path,
      sha256: region ? regionDigest(region.start, region.end) : (fileHash ??= sha256(text)),
      excerpt: node.getText(tree).slice(0, 120).replace(/\s+/g, " "),
    });
  };
  /** Lazy or failure-guarded: inside a real function, or inside a `try` block. Bundler lazy-module
   * wrappers (`__commonJSMin(...)`) usually run during module evaluation, so they stay eager. */
  const nested = (node: ts.Node) => {
    for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
      if (ts.isTryStatement(parent) && parent.tryBlock === child) return true;
      if (!ts.isFunctionLike(parent) && !ts.isClassStaticBlockDeclaration(parent)) continue;
      const wrapper =
        ts.isCallExpression(parent.parent) &&
        /^__(?:commonJS|esm)(?:Min)?$/.test(parent.parent.expression.getText(tree));
      if (!wrapper) return true;
    }
    return false;
  };
  const literal = (node: ts.Expression | undefined) =>
    node && ts.isStringLiteralLike(node) ? node.text : undefined;
  const isCreateRequire = (callee: ts.Expression) => {
    const text = callee.getText(tree);
    return createRequireName.test(text) || createRequireAliases.has(text);
  };
  /** Only the tsdown shim form `createRequire(import.meta.url)` is a trusted require factory. */
  const isShim = (node: ts.Expression): node is ts.CallExpression =>
    ts.isCallExpression(node) &&
    isCreateRequire(node.expression) &&
    node.arguments.length === 1 &&
    node.arguments[0]!.getText(tree) === "import.meta.url";
  const edge = (node: ts.Node, kind: GraphEdgeKind, argument: ts.Expression | undefined) => {
    const value = literal(argument);
    if (value === undefined)
      return site(kind === "dynamic" ? "non-literal-import" : "non-literal-require", node);
    edges.push({
      specifier: value,
      kind,
      eager: kind === "static" || (kind === "require" && !nested(node)),
    });
  };
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      edge(node, "static", node.moduleSpecifier as ts.Expression);
      const from = literal(node.moduleSpecifier as ts.Expression);
      if (ts.isImportDeclaration(node) && (from === "module" || from === "node:module")) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings))
          for (const element of bindings.elements)
            if ((element.propertyName ?? element.name).text === "createRequire")
              createRequireAliases.add(element.name.text);
      }
    }
    if (
      (ts.isPropertyAccessExpression(node) && ["dlopen", "_load"].includes(node.name.text)) ||
      (ts.isElementAccessExpression(node) &&
        ["dlopen", "_load", "createRequire"].includes(literal(node.argumentExpression) ?? ""))
    )
      site("native-loader", node);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isShim(node.initializer)
    )
      requireAliases.add(node.name.text);
    if (ts.isNewExpression(node) && node.expression.getText(tree) === "Function")
      site("generated-code", node);
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const text = callee.getText(tree);
      const target = ts.isPropertyAccessExpression(callee) ? callee.expression : undefined;
      if (text === "eval" || text === "Function") site("generated-code", node);
      else if (callee.kind === ts.SyntaxKind.ImportKeyword)
        edge(node, "dynamic", node.arguments[0]);
      else if (text === "import.meta.resolve") edge(node, "resolve", node.arguments[0]);
      else if (isCreateRequire(callee)) {
        if (!isShim(node)) site("create-require-variable", node);
      } else if (isShim(callee) || requireAliases.has(text) || requireCall.test(text))
        edge(node, "require", node.arguments[0]);
      else if (
        target &&
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "resolve" &&
        (isShim(target) ||
          requireAliases.has(target.getText(tree)) ||
          requireCall.test(target.getText(tree)))
      )
        edge(node, "require-resolve", node.arguments[0]);
    }
    if (
      ts.isNewExpression(node) &&
      node.expression.getText(tree) === "URL" &&
      node.arguments?.[1]?.getText(tree) === "import.meta.url"
    ) {
      const value = literal(node.arguments[0]);
      if (value !== undefined && (value.startsWith("./") || value.startsWith("../")))
        edges.push({ specifier: value, kind: "url", eager: false });
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return { path, edges, sites };
}
