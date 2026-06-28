import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cwd, exit } from "node:process";

const repoRoot = cwd();
const source = join(repoRoot, "apps/mobile-web/dist");
const target = join(repoRoot, "apps/server/dist/mobile-web");
const indexHtml = join(source, "index.html");

if (!existsSync(indexHtml)) {
  console.error(
    "[mobile-web] Missing apps/mobile-web/dist/index.html. Run the mobile build first.",
  );
  exit(1);
}

rmSync(target, { force: true, recursive: true });
cpSync(source, target, { recursive: true });
console.log("[mobile-web] Copied desktop mobile companion into apps/server/dist/mobile-web");
