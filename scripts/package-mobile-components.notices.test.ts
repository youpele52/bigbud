import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { cleanupMobileFixtures, mobileFixture } from "./package-mobile-components.fixture.ts";
import { packageMobileComponents } from "./package-mobile-components.producer.ts";

afterEach(cleanupMobileFixtures);

async function withNotices() {
  const fixture = await mobileFixture();
  const gateway = join(fixture.root, "gateway-NOTICES");
  const assets = join(fixture.root, "assets-NOTICES");
  await writeFile(gateway, "gateway crates notices\n");
  await writeFile(assets, "mobile npm notices\n");
  return { ...fixture, notices: { gateway, assets } };
}

it("writes unsigned notice sidecars beside the artifacts without changing signed metadata", async () => {
  const { root, input, notices } = await withNotices();
  const plain = await packageMobileComponents({ ...input, outputDirectory: join(root, "out2") });
  const signed = await packageMobileComponents({ ...input, notices });
  expect(signed).toEqual(plain);
  expect((await readdir(input.outputDirectory)).toSorted()).toEqual([
    "manifest.json",
    "mobile-assets-4.tar.gz",
    "mobile-assets-4.tar.gz.THIRD_PARTY_NOTICES",
    "mobile-gateway-3-aarch64-unknown-linux-musl",
    "mobile-gateway-3-aarch64-unknown-linux-musl.THIRD_PARTY_NOTICES",
  ]);
  const read = (name: string) => readFile(join(input.outputDirectory, name), "utf8");
  expect(await read("mobile-gateway-3-aarch64-unknown-linux-musl.THIRD_PARTY_NOTICES")).toBe(
    "gateway crates notices\n",
  );
  expect(await read("mobile-assets-4.tar.gz.THIRD_PARTY_NOTICES")).toBe("mobile npm notices\n");
  expect(await read("manifest.json")).toBe(
    await readFile(join(root, "out2", "manifest.json"), "utf8"),
  );
});

it("refuses empty or binary notice inputs before signing", async () => {
  const { input, notices } = await withNotices();
  await writeFile(notices.assets, Buffer.from([0x41, 0, 0x42]));
  await expect(packageMobileComponents({ ...input, notices })).rejects.toThrow(
    "Notice inputs must be non-empty text.",
  );
  await expect(readdir(input.outputDirectory)).rejects.toThrow();
});
