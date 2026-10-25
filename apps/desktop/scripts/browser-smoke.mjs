import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = fileURLToPath(new URL("..", import.meta.url));
const outputDir = mkdtempSync(join(tmpdir(), "bigbud-browser-smoke-"));
const require = createRequire(import.meta.url);
const entry = process.argv[2] ?? "src/window/browserCompatibility.smoke.ts";

try {
  const build = spawnSync(
    "bun",
    [
      "build",
      entry,
      "--target=node",
      "--format=cjs",
      "--external",
      "electron",
      "--outfile",
      join(outputDir, "browser-smoke.cjs"),
    ],
    { cwd: desktopDir, stdio: "inherit" },
  );
  if (build.status !== 0) throw build.error ?? new Error("Browser smoke build failed.");
  const env = { ...process.env, BIGBUD_BROWSER_SMOKE_DIR: outputDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(require("electron"), [join(outputDir, "browser-smoke.cjs")], {
    env,
    stdio: "inherit",
    timeout: 60_000,
  });
  if (run.status !== 0) throw run.error ?? new Error("Native browser smoke failed.");
  if (!existsSync(join(outputDir, "passed")))
    throw new Error("Native browser smoke exited before completing its assertions.");
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}
