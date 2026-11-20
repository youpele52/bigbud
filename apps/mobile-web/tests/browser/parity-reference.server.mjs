import ts from "typescript";

// Test-only document route. Production entrypoints never import this fixture.
export function parityReferencePlugin({
  route = "/__mobile-parity-reference",
  entry = "/tests/browser/parity-reference.entry.mjs",
} = {}) {
  return {
    name: "mobile-current-desktop-reference",
    enforce: "pre",
    transform(code, id, options) {
      if (options?.ssr || !/\.[cm]?[jt]sx?$/.test(id.split("?")[0]) || !code.includes(".css"))
        return null;
      const file = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true);
      const replacements = [];
      for (const node of file.statements) {
        if (
          !ts.isImportDeclaration(node) ||
          node.importClause ||
          !ts.isStringLiteral(node.moduleSpecifier) ||
          !node.moduleSpecifier.text.endsWith(".css")
        )
          continue;
        // ?inline runs the actual Vite/Tailwind CSS pipeline without /@vite/client's
        // updateStyle/HMR transport. Immutable fixture sources never hot-reload.
        const binding = `__fixtureCss${replacements.length}`;
        replacements.push({
          start: node.getStart(file),
          end: node.end,
          code: `import ${binding} from ${JSON.stringify(`${node.moduleSpecifier.text}?inline`)};\n{ const style = document.createElement("style"); style.textContent = ${binding}; document.head.appendChild(style); }`,
        });
      }
      if (!replacements.length) return null;
      for (const replacement of replacements.toReversed())
        code = code.slice(0, replacement.start) + replacement.code + code.slice(replacement.end);
      return { code, map: null };
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== route) return next();
        // Do not transformIndexHtml: it injects Vite's socket client even with hmr:false.
        // React refresh is already disabled by that setting; ESM is transformed on request.
        response.setHeader("Content-Type", "text/html");
        response.end(
          `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
        );
      });
    },
  };
}
