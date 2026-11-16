import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Use the compiler/scanner owned by the installed, declared Vite plugin.
const requirePlugin = createRequire(createRequire(import.meta.url).resolve("@tailwindcss/vite"));
interface ScanSource {
  base: string;
  pattern: string;
  negated: boolean;
}
const { compile } = requirePlugin("@tailwindcss/node") as {
  compile: (
    css: string,
    options: { base: string; onDependency: (path: string) => void },
  ) => Promise<{ sources: ScanSource[]; build: (candidates: string[]) => string }>;
};
const { Scanner } = requirePlugin("@tailwindcss/oxide") as {
  Scanner: new (options: { sources: ScanSource[] }) => { files: string[]; scan: () => string[] };
};

it("generates imported web component utilities from the mobile stylesheet entry", async () => {
  const stylesheet = fileURLToPath(new URL("./mobile.css", import.meta.url));
  const mobileRoot = resolve(dirname(stylesheet), "..");
  const compiler = await compile(await readFile(stylesheet, "utf8"), {
    base: dirname(stylesheet),
    onDependency() {},
  });
  const scanner = new Scanner({
    sources: [
      { base: mobileRoot, pattern: "src/**/*.{ts,tsx}", negated: false },
      ...compiler.sources,
    ],
  });
  const candidates = scanner.scan();
  const webMenu = fileURLToPath(
    new URL("../../web/src/components/ui/SearchableMenuList.tsx", import.meta.url),
  );
  expect(scanner.files).toContain(webMenu);
  const css = compiler.build(candidates);
  expect(css).toContain(".focus\\:outline-none");
  expect(css).toContain("outline-style: none");
});
