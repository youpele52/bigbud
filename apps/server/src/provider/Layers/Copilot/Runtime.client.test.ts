import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import Path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLeasedCopilotClient } from "./Runtime.client.ts";
import { activeCopilotLeases, withCopilotRuntimeLock } from "@bigbud/shared/copilotRuntime.storage";

const control = vi.hoisted(() => ({ errors: [] as Error[], constructError: false }));
vi.mock("@github/copilot-sdk", async (original) => ({
  ...(await original<typeof import("@github/copilot-sdk")>()),
  CopilotClient: class {
    constructor() {
      if (control.constructError) throw new Error("constructor failed");
    }
    async stop() {
      return control.errors;
    }
    async forceStop() {}
  },
}));
const roots: string[] = [];
afterEach(async () => {
  control.errors = [];
  control.constructError = false;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function storage() {
  const root = await mkdtemp(Path.join(tmpdir(), "copilot-client-"));
  roots.push(root);
  return root;
}
const leases = (root: string) => withCopilotRuntimeLock(root, () => activeCopilotLeases(root));

describe("Copilot client runtime leases", () => {
  it("holds its lease until successful stop and releases idempotently", async () => {
    const root = await storage();
    const client = await createLeasedCopilotClient(
      { binaryPath: "/configured/copilot" },
      undefined,
      root,
    );
    expect(await leases(root)).toBe(1);
    await client.stop();
    await client.stop();
    expect(await leases(root)).toBe(0);
  });
  it("retains ownership on uncertain stop until force-stop succeeds", async () => {
    const root = await storage();
    const client = await createLeasedCopilotClient(
      { binaryPath: "/configured/copilot" },
      undefined,
      root,
    );
    control.errors = [new Error("stop failed")];
    await client.stop();
    expect(await leases(root)).toBe(1);
    await client.forceStop();
    expect(await leases(root)).toBe(0);
  });
  it("releases a lease if client construction fails before starting a process", async () => {
    const root = await storage();
    control.constructError = true;
    await expect(
      createLeasedCopilotClient({ binaryPath: "/configured/copilot" }, undefined, root),
    ).rejects.toThrow("constructor failed");
    expect(await leases(root)).toBe(0);
  });
});
