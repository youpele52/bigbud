import { publicationFixture } from "../remote-agent/mobileOptionalPublication.test-fixtures.ts";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  prepareMobileGatewayAssets,
  removeMobileGatewayAssets,
  mobileGatewayAssetsPath,
  markMobileGatewayAssetsLaunched,
} from "./mobileGatewayProcess.assets.ts";

const wiring = vi.hoisted(() => ({
  afterInventory: undefined as undefined | ((path: string) => Promise<void>),
}));
vi.mock("./mobileGatewayProcess.assets.inventory.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./mobileGatewayProcess.assets.inventory.ts")>();
  return {
    ...actual,
    verifyMobileRuntimeInventory: async (
      ...args: Parameters<typeof actual.verifyMobileRuntimeInventory>
    ) => {
      await actual.verifyMobileRuntimeInventory(...args);
      await wiring.afterInventory?.(args[0]);
    },
  };
});
const fixtures: Awaited<ReturnType<typeof publicationFixture>>[] = [];
afterEach(async () => {
  wiring.afterInventory = undefined;
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = await publicationFixture();
  fixtures.push(f);
  return f;
}
it("extracts a fresh signed runtime and removes only its unchanged original tree", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      assets = await prepareMobileGatewayAssets(
        proof,
        "runtime-clean",
        new AbortController().signal,
      ),
      path = mobileGatewayAssetsPath(assets);
    expect(await fs.readFile(join(path, "index.html"), "utf8")).toContain("fixture");
    await expect(removeMobileGatewayAssets(proof, { ...assets })).rejects.toThrow(/Original/);
    await removeMobileGatewayAssets(proof, assets);
    await expect(fs.lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
it("preserves foreign content inserted after successful inventory verification at the authority boundary", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      assets = await prepareMobileGatewayAssets(
        proof,
        "runtime-foreign",
        new AbortController().signal,
      ),
      path = mobileGatewayAssetsPath(assets);
    wiring.afterInventory = async (root) => {
      wiring.afterInventory = undefined;
      await fs.writeFile(join(root, "foreign.txt"), "do not delete", { flag: "wx", mode: 0o600 });
    };
    await expect(removeMobileGatewayAssets(proof, assets)).rejects.toThrow(
      /changed|Foreign|foreign/,
    );
    expect(await fs.readFile(join(path, "foreign.txt"), "utf8")).toBe("do not delete");
  });
});
it("retains assets when child exit is unconfirmed or the runtime inode was substituted", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      assets = await prepareMobileGatewayAssets(
        proof,
        "runtime-uncertain",
        new AbortController().signal,
      ),
      path = mobileGatewayAssetsPath(assets);
    markMobileGatewayAssetsLaunched(assets);
    await expect(removeMobileGatewayAssets(proof, assets)).rejects.toThrow(/exit/);
    expect(await fs.readFile(join(path, "index.html"), "utf8")).toContain("fixture");
    const untouched = await prepareMobileGatewayAssets(
        proof,
        "runtime-substitute",
        new AbortController().signal,
      ),
      other = mobileGatewayAssetsPath(untouched);
    await fs.rename(other, other + ".saved");
    await fs.mkdir(other, { mode: 0o700 });
    await fs.writeFile(join(other, "foreign.txt"), "replacement", { mode: 0o600 });
    await expect(removeMobileGatewayAssets(proof, untouched)).rejects.toThrow(/substituted/);
    expect(await fs.readFile(join(other, "foreign.txt"), "utf8")).toBe("replacement");
  });
});
