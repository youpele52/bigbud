import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * Runs the exact worker bundling step of `bun run build` into a temp directory and checks the
 * resulting `_worker.js` is a self-contained module worker that Cloudflare Pages can deploy.
 */

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = mkdtempSync(join(tmpdir(), "bigbud-marketing-worker-"));
const OUT_FILE = join(OUT_DIR, "_worker.js");
const MAX_BUNDLE_BYTES = 64 * 1024;

function bundleArgs(): string[] {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as {
    readonly scripts: Record<string, string>;
  };
  const step = manifest.scripts.build?.split("&&").find((part) => part.includes("bun build"));
  if (!step) throw new Error("The build script no longer bundles the worker.");
  const args = step.trim().split(/\s+/).slice(1);
  const outfile = args.findIndex((arg) => arg === "--outfile=dist/_worker.js");
  if (outfile === -1) throw new Error("The worker must be bundled to dist/_worker.js.");
  args[outfile] = `--outfile=${OUT_FILE}`;
  return args;
}

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(OUT_DIR, { recursive: true, force: true });
});

describe("dist/_worker.js bundle", () => {
  execFileSync("bun", bundleArgs(), { cwd: PACKAGE_DIR, stdio: "pipe" });
  const source = readFileSync(OUT_FILE, "utf8");

  it("is small and has no imports left", () => {
    expect(Buffer.byteLength(source)).toBeLessThan(MAX_BUNDLE_BYTES);
    expect(source).not.toMatch(/^\s*import[\s{*]/m);
    expect(source).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
  });

  it("exports a module worker that serves downloads and forwards the rest", async () => {
    vi.stubGlobal("caches", { default: { match: vi.fn(), put: vi.fn() } });
    const worker = (await import(pathToFileURL(OUT_FILE).href)) as {
      readonly default: {
        readonly fetch: (request: Request, env: unknown, context: unknown) => Promise<Response>;
      };
    };
    const env = { ASSETS: { fetch: vi.fn(async () => new Response("asset")) } };
    const context = { waitUntil: vi.fn() };

    const pinned = await worker.default.fetch(
      new Request("https://bigbud.app/download/v0.4.0-beta.5/remote-agent"),
      env,
      context,
    );
    expect(pinned.status).toBe(302);
    const page = await worker.default.fetch(new Request("https://bigbud.app/nope"), env, context);
    expect(await page.text()).toBe("asset");
  });
});
