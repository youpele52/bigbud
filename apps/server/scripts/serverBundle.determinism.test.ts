import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";
import { expect, it } from "vitest";
import serverBundleConfig from "../tsdown.config.ts";

const serverRoot = fileURLToPath(new URL("../", import.meta.url));

async function buildBundle(outDir: string) {
  await build({
    ...serverBundleConfig,
    config: false,
    cwd: serverRoot,
    entry: {
      bin: fileURLToPath(new URL("../src/bin.ts", import.meta.url)),
      NodeSqliteWorker: fileURLToPath(
        new URL("../src/persistence/NodeSqliteWorker.ts", import.meta.url),
      ),
    },
    outDir,
    copy: [],
    sourcemap: false,
    logLevel: "silent",
  });
  const files = new Map<string, string>();
  for (const name of (await readdir(outDir)).toSorted()) {
    const text = await readFile(join(outDir, name), "utf8");
    files.set(name, createHash("sha256").update(text).digest("hex"));
  }
  return files;
}

// The backend graph's archive hash and buildDigest are only reproducible when the bundle is.
it("builds a byte-identical server bundle every time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bigbud-bundle-determinism-"));
  try {
    const first = await buildBundle(join(directory, "one"));
    const second = await buildBundle(join(directory, "two"));
    expect([...second]).toEqual([...first]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// The loader policy attributes reviewed code by `//#region` marker. Constant inlining drops the
// first statement of Pi/Cli.ts (`DEFAULT_PI_BINARY_PATH`) and its marker with it, which moved
// Pi's reviewed createRequire site under the preceding module.
it("keeps the region marker of a module whose first statement is an inlinable constant", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bigbud-bundle-regions-"));
  try {
    const output = join(directory, "dist");
    const files = await buildBundle(output);
    const texts = await Promise.all(
      [...files.keys()].map((name) => readFile(join(output, name), "utf8")),
    );
    const marker = /^\/\/#region src\/provider\/Layers\/Pi\/Cli\.ts\n(?:.*\n)*?\/\/#endregion$/m;
    const region = texts.map((text) => marker.exec(text)?.[0]).find(Boolean);
    expect(region).toContain('const DEFAULT_PI_BINARY_PATH = "pi";');
    expect(region).toContain("createRequire(import.meta.url)");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
