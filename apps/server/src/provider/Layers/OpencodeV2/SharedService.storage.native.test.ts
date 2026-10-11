import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { expect, it } from "vitest";
import { sharedServiceNativeFixture } from "./SharedService.native.fixture.ts";
import { resolveV2SharedStorage } from "./SharedService.storage.ts";
import { discoverV2SharedService } from "./SharedService.discovery.ts";
import path from "node:path";

const binary = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY;
const version = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION;
if (process.env.BIGBUD_OPENCODE_V2_REQUIRED_NATIVE === "1" && (!binary || !version))
  throw new Error("Required native storage validation cannot skip.");

it.skipIf(!binary || !version)(
  "distinguishes another native database with an extensionless custom name and spaces",
  async () => {
    const first = await sharedServiceNativeFixture(binary!);
    try {
      const second = await sharedServiceNativeFixture(binary!, undefined, "native state");
      try {
        const a = await resolveV2SharedStorage(first.file);
        const b = await resolveV2SharedStorage(second.file);
        expect(path.basename(b.databasePath)).toBe("native state");
        expect(b.storageIdentity).not.toBe(a.storageIdentity);
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }
  },
);

it.skipIf(!binary || !version)(
  "retains the actual DB identity across a fixture-owned service restart without changing native config",
  async () => {
    const fixture = await sharedServiceNativeFixture(binary!);
    try {
      await expect
        .poll(async () => (await discoverV2SharedService({ file: fixture.file })).version)
        .toBe(version);
      const config = await readFile(fixture.configFile);
      const before = await resolveV2SharedStorage(fixture.file);
      if (process.platform === "darwin") {
        const metadata = await stat(before.databasePath);
        const legacy = createHash("sha256")
          .update(
            JSON.stringify([
              "opencodeV2-shared-local",
              before.databasePath,
              metadata.dev,
              metadata.ino,
            ]),
          )
          .digest("hex");
        expect(before.storageIdentity).toBe(legacy);
      }
      await fixture.restart();
      await expect
        .poll(async () => (await discoverV2SharedService({ file: fixture.file })).version)
        .toBe(version);
      const after = await resolveV2SharedStorage(fixture.file);
      expect(after.storageIdentity).toBe(before.storageIdentity);
      expect(after.generation).not.toBe(before.generation);
      expect(await readFile(fixture.configFile)).toEqual(config);
    } finally {
      await fixture.close();
    }
  },
);
