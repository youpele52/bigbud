import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

it("the production V2 runtime import graph cannot retain private/SSH/development factories or the legacy private SDK", async () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const visited = new Set<string>();
  const pending = [path.join(root, "Application.composition.ts")];
  while (pending.length) {
    const filename = pending.pop()!;
    if (visited.has(filename)) continue;
    visited.add(filename);
    const source = ts.createSourceFile(
      filename,
      await readFile(filename, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
      const clause = node.importClause;
      if (
        clause?.isTypeOnly ||
        (clause?.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          !clause.name &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly))
      )
        continue;
      const target = node.moduleSpecifier.text;
      expect(target, `${filename} imported private SDK`).not.toMatch(/^@opencode-ai\/sdk(?:\/|$)/);
      if (!target.startsWith(".")) continue;
      let resolved = path.resolve(path.dirname(filename), target);
      if (!path.extname(resolved)) {
        for (const suffix of [".ts", ".tsx", ".mjs"]) {
          if (
            await stat(resolved + suffix).then(
              () => true,
              () => false,
            )
          ) {
            resolved += suffix;
            break;
          }
        }
      }
      expect(resolved, `${filename} reached a private V2 launcher`).not.toMatch(
        /OpencodeV2\/(?:ServerManager\.(?:child|ssh|fixture)|Development\.(?:composition|config)|Application\.(?:config|targets|fixture)\.ts|Adapter\.execution\.ts)/,
      );
      pending.push(resolved);
    }
  }
  const manager = await readFile(path.join(root, "ServerManager.ts"), "utf8");
  expect(manager).not.toContain("startOwnedV2Process");
  const composition = await readFile(
    path.resolve(root, "../OptionalProviderComposition.ts"),
    "utf8",
  );
  expect(composition).not.toContain("makeV2DevelopmentRegistration");
  expect(composition).not.toContain("BIGBUD_ENABLE_OPENCODE_V2_DEVELOPMENT");
});
