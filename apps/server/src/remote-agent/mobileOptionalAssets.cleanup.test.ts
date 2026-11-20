import {
  cleanupOwnedMobileAssetTree,
  mobileAssetIdentity,
} from "./mobileOptionalAssets.cleanup.ts";
import * as fs from "node:fs/promises";
import * as sync from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { extractMobileOptionalAssets } from "./mobileOptionalAssets.ts";
import { signedRequest, tarBytes, tarMember } from "./mobileOptionalAssets.test-fixture.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function parent() {
  const path = await fs.mkdtemp("/tmp/bb-asset-cleanup-");
  await fs.chmod(path, 0o700);
  roots.push(path);
  return fs.realpath(path);
}
it.each(["foreign-entry", "replaced-completed-file"] as const)(
  "rollback preserves %s introduced after a signed member completed",
  async (mode) => {
    const root = await parent(),
      input = signedRequest(
        root,
        tarBytes([tarMember("index.html", "0", "signed original"), tarMember("assets/", "5", "")]),
      );
    const controller = new AbortController(),
      original = controller.signal.throwIfAborted.bind(controller.signal);
    let injected = false;
    vi.spyOn(controller.signal, "throwIfAborted").mockImplementation(() => {
      const index = join(input.destination, "index.html");
      if (!injected && sync.existsSync(index)) {
        injected = true;
        if (mode === "foreign-entry")
          sync.writeFileSync(join(input.destination, "foreign.txt"), "foreign bytes", {
            flag: "wx",
            mode: 0o600,
          });
        else {
          sync.renameSync(index, index + ".saved");
          sync.writeFileSync(index, "foreign replacement", { flag: "wx", mode: 0o600 });
        }
        controller.abort(Error("fixture interrupts after foreign mutation"));
      }
      original();
    });
    await expect(
      extractMobileOptionalAssets({ ...input, signal: controller.signal }),
    ).rejects.toThrow();
    expect(injected).toBe(true);
    expect(
      await fs.readFile(
        join(input.destination, mode === "foreign-entry" ? "foreign.txt" : "index.html"),
        "utf8",
      ),
    ).toBe(mode === "foreign-entry" ? "foreign bytes" : "foreign replacement");
    if (mode === "replaced-completed-file")
      expect(await fs.readFile(join(input.destination, "index.html.saved"), "utf8")).toBe(
        "signed original",
      );
  },
);

it("preserves same-inode foreign bytes in an incomplete leaf without a completed fingerprint", async () => {
  const root = await parent(),
    destination = join(root, "owned"),
    file = join(destination, "partial.js");
  await fs.mkdir(destination, { mode: 0o700 });
  await fs.writeFile(file, "owned partial", { mode: 0o600 });
  const identity = mobileAssetIdentity(await fs.lstat(file));
  await fs.writeFile(file, "foreign in-place bytes", { mode: 0o600 });
  cleanupOwnedMobileAssetTree(
    new Map([[destination, mobileAssetIdentity(await fs.lstat(destination))]]),
    new Map([[file, { identity }]]),
  );
  expect(await fs.readFile(file, "utf8")).toBe("foreign in-place bytes");
});
