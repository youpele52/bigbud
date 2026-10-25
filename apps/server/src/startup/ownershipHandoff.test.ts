import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ownershipHandoffFixture as fixture } from "./ownershipHandoff.test-fixture";
describe.skipIf(process.platform === "win32")("cooperative handoff", () => {
  it("requires a matching identity and supervisor acknowledgment before shutdown", async () => {
    const f = await fixture();
    expect(await f.request("inspect", "wrong-owner")).toBe("owner_changed");
    expect(await f.request("commit")).toBe("supervisor_unavailable");
    expect(f.shutdown).not.toHaveBeenCalled();
    expect(await f.request("prepare")).toBe("prepared");
    expect(f.prepared()).toBe(true);
    expect(await f.request("prepare")).toBe("prepared");
    expect(await f.request("commit")).toBe("committed");
    expect(await f.request("commit")).toBe("committed");
    expect(f.shutdown).toHaveBeenCalledOnce();
    expect(await f.request("status")).toBe("committed");
  });
  it("does not shut down when the supervisor refuses", async () => {
    const f = await fixture(false);
    expect(await f.request("prepare")).toBe("supervisor_unavailable");
    expect(await f.request("commit")).toBe("supervisor_unavailable");
    expect(f.shutdown).not.toHaveBeenCalled();
  });
  it("lets a new authenticated requester finish an abandoned preparation", async () => {
    const f = await fixture();
    expect(await f.request("prepare")).toBe("prepared");
    expect(f.shutdown).not.toHaveBeenCalled();
    // The first requester's process can disappear here; no lease or reset is required.
    expect(await f.request("status", undefined, "b".repeat(32))).toBe("prepared");
    expect(await f.request("prepare", undefined, "b".repeat(32))).toBe("prepared");
    expect(await f.request("commit", undefined, "b".repeat(32))).toBe("committed");
    expect(f.shutdown).toHaveBeenCalledOnce();
  });
  it("rechecks the acquisition before a different requester commits", async () => {
    const f = await fixture();
    expect(await f.request("prepare")).toBe("prepared");
    await writeFile(f.lock.lockPath, JSON.stringify({ ...f.lock.record, nonce: "c".repeat(32) }));
    await expect(f.request("commit", undefined, "b".repeat(32))).rejects.toThrow();
    expect(f.shutdown).not.toHaveBeenCalled();
  });
});
