import { builtinModules, createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import * as ts from "typescript";
import { readStableFile } from "./lib/artifact-build/io.ts";
import type { BackendGraphFile } from "../apps/server/src/remote-backend/backendGraph.manifest.ts";
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

/** Static dependency inventory only, never executes graph files. Known dynamic loaders are
 * refused. This parser is not a semantic proof of native/provider/shared-library closure. */
export async function validateBackendGraphClosure(
  root: string,
  files: ReadonlyArray<BackendGraphFile>,
) {
  const members = new Set(files.map((file) => file.path));
  for (const file of files) {
    if (!/\.(?:cjs|mjs|js)$/.test(file.path)) continue;
    const absolute = join(root, file.path);
    const read = await readStableFile(absolute, 16 * 1024 * 1024);
    if (read.sha256 !== file.sha256)
      throw new Error("Graph source changed before closure validation.");
    const tree = ts.createSourceFile(
      file.path,
      read.bytes.toString("utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const parsed = ts.transpileModule(read.bytes.toString("utf8"), {
      fileName: file.path,
      reportDiagnostics: true,
      compilerOptions: {
        allowJs: true,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.Latest,
      },
    });
    if (
      parsed.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    )
      throw new Error("Executable graph contains invalid JavaScript syntax.");
    const requireFrom = createRequire(absolute);
    const requireAliases = new Set(["require"]);
    function dependency(value: string) {
      if (value === "module" || value === "node:module" || value.endsWith(".node"))
        throw new Error(
          "Unsupported dynamic/native loader closure requires separate qualification.",
        );
      if (builtins.has(value)) return;
      let target: string;
      try {
        target = value.startsWith(".")
          ? resolve(dirname(absolute), value)
          : requireFrom.resolve(value);
      } catch {
        throw new Error(`Graph has an unresolved dependency in ${file.path}.`);
      }
      const path = relative(root, target);
      if (!members.has(path))
        throw new Error(`Graph dependency escapes declared membership in ${file.path}.`);
    }
    function literal(node: ts.Expression | undefined): string {
      if (!node || !ts.isStringLiteralLike(node))
        throw new Error(`Unsupported dynamic graph closure in ${file.path}.`);
      return node.text;
    }
    function visit(node: ts.Node) {
      if (
        (ts.isPropertyAccessExpression(node) &&
          ["dlopen", "_load", "createRequire"].includes(node.name.text)) ||
        (ts.isElementAccessExpression(node) &&
          node.argumentExpression &&
          ts.isStringLiteralLike(node.argumentExpression) &&
          ["dlopen", "_load", "createRequire"].includes(node.argumentExpression.text))
      )
        throw new Error(
          "Unsupported dynamic/native loader closure requires separate qualification.",
        );
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
        dependency(literal(node.moduleSpecifier as ts.Expression));
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        node.initializer.expression.getText(tree).endsWith("createRequire")
      )
        requireAliases.add(node.name.text);
      if (ts.isCallExpression(node)) {
        const call = node.expression.getText(tree);
        if (call === "eval" || call === "Function")
          throw new Error("Executable graph contains unsupported generated code.");
        if (
          node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          requireAliases.has(call) ||
          /(?:^|_)require\d*$/.test(call) ||
          [...requireAliases].some((name) => call === `${name}.resolve`)
        )
          dependency(literal(node.arguments[0]));
      }
      if (ts.isNewExpression(node) && node.expression.getText(tree) === "Function")
        throw new Error("Executable graph contains unsupported generated code.");
      if (
        ts.isNewExpression(node) &&
        node.expression.getText(tree) === "URL" &&
        node.arguments?.[1]?.getText(tree) === "import.meta.url"
      )
        dependency(literal(node.arguments[0]));
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
}
