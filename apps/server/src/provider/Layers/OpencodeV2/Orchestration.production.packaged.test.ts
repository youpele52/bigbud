import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, copyFile, readFile, rm, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { build } from "tsdown";
import { expect, it } from "vitest";
import serverCompiler from "../../../../tsdown.config.ts";
import { v2ThreadImplementation } from "./Orchestration.implementation.ts";

it("the release compiler bundles genuine A/B handlers and the canonical HTTP/SQLite pipeline without a source checkout at runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-packaged-pipeline-")),
    output = path.join(root, "package"),
    home = path.join(root, "home");
  await mkdir(home, { mode: 0o700 });
  try {
    await build({
      ...serverCompiler,
      config: false,
      cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
      entry: [
        fileURLToPath(new URL("./Orchestration.production.packaged.fixture.ts", import.meta.url)),
      ],
      outDir: output,
      copy: [],
      dts: false,
      clean: true,
      sourcemap: false,
    });
    for (const name of [
      "SharedService.official.ndjson",
      "NativeCompatibility.official.ndjson",
      "ProfileIsolation.mjs",
      "ProfileIsolation.windows.mjs",
    ])
      await copyFile(fileURLToPath(new URL(`./${name}`, import.meta.url)), path.join(output, name));
    const bundle = path.join(output, "Orchestration.production.packaged.fixture.mjs");
    const bytes = await readFile(bundle),
      digest = createHash("sha256").update(bytes).digest("hex");
    const result = await promisify(execFile)(process.execPath, [bundle], {
      cwd: home,
      env: {
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_STATE_HOME: path.join(home, "state"),
        XDG_CACHE_HOME: path.join(home, "cache"),
        TMPDIR: root,
        TMP: root,
        TEMP: root,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      },
      maxBuffer: 1048576,
      timeout: 60000,
    });
    const report = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    expect(report).toMatchObject({
      nativeQualified: false,
      canonicalCreates: 1,
      aReturnedCount: 2,
      bReturnedCount: 1,
      pinnedA: true,
      pinnedB: true,
      completedDuplicates: true,
      bootstrapBytesAndInodesUnchanged: true,
      aDigest: v2ThreadImplementation("v1").implementationDigest,
      bDigest: v2ThreadImplementation("v2").implementationDigest,
    });
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
