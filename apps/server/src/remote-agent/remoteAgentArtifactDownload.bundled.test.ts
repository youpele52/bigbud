import { afterEach, expect, it, vi } from "vitest";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
const mutation = vi.hoisted(() => ({ beforeOpen: undefined as undefined | (() => Promise<void>) }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      await mutation.beforeOpen?.();
      return actual.open(...args);
    },
  };
});
import { downloadRemoteAgentArtifact } from "./remoteAgentArtifactDownload.ts";
const roots: string[] = [];
afterEach(async () => {
  mutation.beforeOpen = undefined;
  await Promise.all(roots.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/ab-"));
  roots.push(root);
  return root;
}
const artifact = (bundledPath: string) => ({
  version: "1-fixture",
  buildDigest: "fixture",
  protocolMajor: 1,
  protocolMinor: 0,
  targetTriple: "x86_64-unknown-linux-gnu" as const,
  sizeBytes: 2,
  sha256: "a".repeat(64),
  signature: { algorithm: "ed25519" as const, keyId: "fixture", value: "signature" },
  bundledPath,
});
it("preserves ordinary bundled files on supported platforms without altering byte verification", async () => {
  const path = join(await fixture(), "artifact");
  await fs.writeFile(path, "ok");
  await expect(downloadRemoteAgentArtifact(artifact(path))).resolves.toEqual(
    new TextEncoder().encode("ok"),
  );
});
it.skipIf(process.platform === "win32")(
  "refuses a real FIFO promptly, including an aborted reader, without a waiting writer",
  async () => {
    const path = join(await fixture(), "fifo");
    await promisify(execFile)("mkfifo", [path]);
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const pending = downloadRemoteAgentArtifact(artifact(path), { signal: controller.signal });
    const outcome = pending.then(
      () => "accepted" as const,
      () => "refused" as const,
    );
    const result = await Promise.race([
      outcome,
      new Promise<"blocked">((resolve) => {
        deadline = setTimeout(() => {
          controller.abort();
          resolve("blocked");
        }, 500);
      }),
    ]);
    try {
      expect(result).toBe("refused");
    } finally {
      if (deadline) clearTimeout(deadline);
      if (result === "blocked") {
        // Release only this test's old blocking reader so a RED run leaves no pending IO.
        const writer = await fs.open(path, constants.O_WRONLY | constants.O_NONBLOCK);
        await writer.close();
      }
      await outcome;
    }
  },
);
it.skipIf(process.platform === "win32")(
  "rejects a link swapped at the actual open boundary",
  async () => {
    const root = await fixture(),
      path = join(root, "artifact"),
      other = join(root, "other");
    await fs.writeFile(path, "ok");
    await fs.writeFile(other, "ok");
    mutation.beforeOpen = async () => {
      mutation.beforeOpen = undefined;
      await fs.unlink(path);
      await fs.symlink(other, path);
    };
    await expect(downloadRemoteAgentArtifact(artifact(path))).rejects.toThrow();
  },
);
