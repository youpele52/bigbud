import { mkdtemp, realpath, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it, vi } from "vitest";
import { V2_DEVELOPMENT_MARKER } from "./Development.config.ts";
import { inspectPrivateV2Profile } from "./ProfileIsolation.mjs";

it.skipIf(process.platform === "win32")(
  "accepts private/sticky temp ancestry but rejects replaceable nonsticky parents; streams a bounded tree",
  async () => {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "v2-parent-policy-")));
    const root = path.join(parent, "profile");
    try {
      await mkdir(root, { mode: 0o700 });
      await writeFile(
        path.join(root, V2_DEVELOPMENT_MARKER),
        "bigbud-opencode-v2-disposable-v1\n",
        { mode: 0o600 },
      );
      await inspectPrivateV2Profile(root);
      const getuid = vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
      try {
        await expect(inspectPrivateV2Profile(root)).rejects.toThrow("owner");
      } finally {
        getuid.mockRestore();
      }
      await chmod(parent, 0o1777);
      await inspectPrivateV2Profile(root);
      await chmod(parent, 0o777);
      await expect(inspectPrivateV2Profile(root)).rejects.toThrow("writable");
      await chmod(parent, 0o700);
      for (let i = 0; i < 5; i++)
        await writeFile(path.join(root, `entry-${i}`), "synthetic", { mode: 0o600 });
      await expect(inspectPrivateV2Profile(root, { maxEntries: 4 })).rejects.toThrow("bound");
      await expect(inspectPrivateV2Profile(root, { signal: AbortSignal.abort() })).rejects.toThrow(
        "cancelled",
      );
      await expect(inspectPrivateV2Profile(root, { timeoutMs: 0 })).rejects.toThrow("timed out");
    } finally {
      await chmod(parent, 0o700);
      await rm(parent, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "win32")(
  "fails closed rather than guessing Windows profile ACL isolation",
  async () => {
    await expect(inspectPrivateV2Profile("C:\\synthetic-profile")).rejects.toThrow(
      "ACL isolation cannot be proven",
    );
  },
);
