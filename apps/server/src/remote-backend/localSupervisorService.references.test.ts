import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeLocalSupervisorServiceReferences } from "./localSupervisorService.references.ts";
import { serviceReferenceFixture } from "./localSupervisorService.references.fixture.ts";
import { remoteAgentBuildId } from "../remote-agent/remoteAgentRuntime.ts";

const fixtures: Awaited<ReturnType<typeof serviceReferenceFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function fixture() {
  const value = await serviceReferenceFixture();
  fixtures.push(value);
  return value;
}

describe("durable service pruning exclusions", () => {
  it("unions owners, all authority configs and older staged/loaded unit launchers without changing pins", async () => {
    const f = await fixture();
    await f.config();
    await f.config("b".repeat(32), f.runtimes[2]);
    const loaded = await f.unit();
    const before = JSON.stringify(f.registry.pins);
    const owners = vi.fn(async () => new Set([remoteAgentBuildId(f.runtimes[2]!)]));
    const references = makeLocalSupervisorServiceReferences({
      control: f.control,
      referencedBuildIds: owners,
      inspectUnits: async () => [loaded],
    });
    expect(await references(f.target)).toEqual(new Set(f.runtimes.map(remoteAgentBuildId)));
    expect(owners).toHaveBeenCalledWith(f.target);
    expect(JSON.stringify(f.registry.pins)).toBe(before);
    expect(f.control.run).not.toHaveBeenCalled();
  });

  it("does not turn an unavailable manager or owner store into empty references", async () => {
    const f = await fixture();
    await f.config();
    const failedOwner = makeLocalSupervisorServiceReferences({
      control: f.control,
      referencedBuildIds: async () => {
        throw new Error("owner store unavailable");
      },
      inspectUnits: async () => [],
    });
    await expect(failedOwner(f.target)).rejects.toThrow("owner store unavailable");
    const failedManager = makeLocalSupervisorServiceReferences({
      control: f.control,
      referencedBuildIds: async () => new Set(),
    });
    await expect(failedManager(f.target)).rejects.toThrow("Unexpected live systemctl");
    await expect(failedManager("ssh:other")).rejects.toThrow("another authority");
  });

  it.each([
    "unsafe-config",
    "linked-config",
    "unfinished-config",
    "unknown-unit",
    "missing-config",
    "foreign-fragment",
    "unknown-binary",
  ] as const)("refuses %s metadata without allowing pruning", async (change) => {
    const f = await fixture();
    await f.config();
    const unit = await f.unit();
    let observations = [unit];
    const path = f.configPath("a".repeat(32));
    if (change === "unsafe-config") await fs.chmod(path, 0o644);
    if (change === "linked-config") {
      await fs.rename(path, `${path}.saved`);
      await fs.symlink(`${path}.saved`, path);
    }
    if (change === "unfinished-config") await f.write(join(path, "../.publication"), "pending");
    if (change === "unknown-unit") await f.write(unit.fragmentPath, "user-managed unit");
    if (change === "missing-config") await fs.rm(join(path, ".."), { recursive: true });
    if (change === "foreign-fragment")
      observations = [{ ...unit, fragmentPath: "/etc/systemd/user/other.service" }];
    if (change === "unknown-binary")
      await f.write(
        unit.fragmentPath,
        (await fs.readFile(unit.fragmentPath, "utf8")).replace(
          f.runtimes[0]!.binaryPath,
          "/unknown/agent",
        ),
      );
    const references = makeLocalSupervisorServiceReferences({
      control: f.control,
      referencedBuildIds: async () => new Set(),
      inspectUnits: async () => observations,
    });
    await expect(references(f.target)).rejects.toThrow();
  });
});
