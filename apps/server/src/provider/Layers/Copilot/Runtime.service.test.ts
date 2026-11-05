import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import Path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CopilotRuntimeState } from "@bigbud/contracts/server/copilotRuntime";
import type { installCopilotRuntime } from "./Runtime.install.ts";
import { copilotRuntimeRequest } from "./Runtime.service.ts";
import { readRuntimeState, writeRuntimeState } from "@bigbud/shared/copilotRuntime.storage";

const control = vi.hoisted(() => ({
  source: "missing" as CopilotRuntimeState["source"],
  available: false,
  install: vi.fn<typeof installCopilotRuntime>(),
}));
vi.mock("./Runtime.install.ts", () => ({ installCopilotRuntime: control.install }));
vi.mock("./Runtime.discovery.ts", async (original) => ({
  ...(await original<typeof import("./Runtime.discovery.ts")>()),
  discoverCopilotRuntime: async () => ({
    available: control.available,
    source: control.source,
    path: control.available ? "/existing/copilot" : null,
    version: control.available ? "1.0.103" : null,
    installedSizeBytes: null,
    error: null,
  }),
}));
const roots: string[] = [];
const result = {
  path: "/fixture/copilot",
  directory: "/fixture",
  target: "darwin-arm64",
  version: "1.0.103",
};
beforeEach(() => {
  control.source = "missing";
  control.available = false;
  control.install.mockReset();
  control.install.mockResolvedValue(result);
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function storage() {
  const root = await mkdtemp(Path.join(tmpdir(), "copilot-service-"));
  roots.push(root);
  return root;
}
const status = (root: string) => copilotRuntimeRequest({ action: "status" }, "copilot", root);
async function finished(root: string, phase: string) {
  await vi.waitFor(async () => expect((await status(root)).job?.phase).toBe(phase), {
    timeout: 5_000,
  });
}

describe("server-owned Copilot runtime lifecycle", () => {
  it("prompts only once for missing runtimes, never downloads during discovery or dismissal", async () => {
    const root = await storage();
    expect((await status(root)).onboarding).toBe(true);
    await copilotRuntimeRequest({ action: "acknowledge" }, "copilot", root);
    expect((await status(root)).onboarding).toBe(false);
    expect(control.install).not.toHaveBeenCalled();
  });
  it.each(["configured", "managed", "bundled-native", "existing", "sdk"] as const)(
    "suppresses setup for existing %s and remembers it across later removal/upgrades",
    async (source) => {
      const root = await storage();
      control.source = source;
      control.available = true;
      expect((await status(root)).onboarding).toBe(false);
      // Discovery after a failed bridge copy must not authorize skipping preservation on update.
      expect(await readRuntimeState(root, ".bridge-preserved.json")).toBeUndefined();
      control.source = "missing";
      control.available = false;
      expect((await status(root)).onboarding).toBe(false);
      expect(control.install).not.toHaveBeenCalled();
    },
  );
  it("tracks one stable operation across status polls/reconnects and rejects a concurrent mutation", async () => {
    const root = await storage();
    let finish: (() => void) | undefined;
    control.install.mockImplementation(async ({ onProgress }) => {
      onProgress?.({ phase: "downloading", transferredBytes: 10, totalBytes: 100 });
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return result;
    });
    const initial = await copilotRuntimeRequest({ action: "install" }, "copilot", root);
    const later = await status(root);
    expect(later.job?.id).toBe(initial.job?.id);
    const conflict = await copilotRuntimeRequest({ action: "update" }, "copilot", root);
    expect(conflict.error).toContain("already in progress");
    expect(control.install).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => expect((await status(root)).job?.transferredBytes).toBe(10));
    finish?.();
    await finished(root, "installed");
  });
  it("cancels only the matching active download and supports retry with a new identity", async () => {
    const root = await storage();
    control.install.mockImplementationOnce(
      async ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const initial = await copilotRuntimeRequest({ action: "install" }, "copilot", root);
    const mismatch = await copilotRuntimeRequest(
      { action: "cancel", jobId: "../external" },
      "copilot",
      root,
    );
    expect(mismatch.error).toContain("current Copilot download");
    await copilotRuntimeRequest({ action: "cancel", jobId: initial.job!.id }, "copilot", root);
    await finished(root, "cancelled");
    const retry = await copilotRuntimeRequest({ action: "install" }, "copilot", root);
    expect(retry.job?.id).not.toBe(initial.job?.id);
    await finished(root, "installed");
  });
  it("records failure and interrupted-owner recovery without automatic retry", async () => {
    const root = await storage();
    control.install.mockRejectedValueOnce(new Error("checksum mismatch"));
    await copilotRuntimeRequest({ action: "install" }, "copilot", root);
    await finished(root, "error");
    expect((await status(root)).job?.error).toBe("checksum mismatch");
    await writeRuntimeState(root, ".job.json", {
      pid: 99999999,
      job: {
        operation: "install",
        id: "old",
        phase: "downloading",
        version: "1.0.103",
        transferredBytes: 12,
        totalBytes: 100,
        error: null,
      },
    });
    expect((await status(root)).job?.error).toContain("interrupted");
    expect(control.install).toHaveBeenCalledTimes(1);
  });
  it("intentional uninstall never re-enables onboarding", async () => {
    const root = await storage();
    await copilotRuntimeRequest({ action: "uninstall" }, "copilot", root);
    await finished(root, "uninstalled");
    expect(await readRuntimeState(root, ".bridge-preserved.json")).toBe(true);
    expect((await status(root)).onboarding).toBe(false);
    expect(control.install).not.toHaveBeenCalled();
  });
});
