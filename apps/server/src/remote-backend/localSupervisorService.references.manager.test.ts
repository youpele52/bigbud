import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectLocalSupervisorServiceUnits } from "./localSupervisorService.references.manager.ts";
import { serviceReferenceFixture } from "./localSupervisorService.references.fixture.ts";

const fixtures: Awaited<ReturnType<typeof serviceReferenceFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture(change?: string) {
  const f = await serviceReferenceFixture();
  fixtures.push(f);
  const name = `bigbud-rust-${"a".repeat(32)}.service`;
  const fragmentPath = f.unitPath(name);
  vi.mocked(f.control.run).mockImplementation(async (_target, script, options) => {
    expect(options).toMatchObject({ timeoutMs: 10_000, maxBufferBytes: 1024 * 1024 });
    expect(script).toContain('export XDG_RUNTIME_DIR="$runtime"');
    const stdout =
      script.includes("list-units") || script.includes("list-unit-files")
        ? `${name} enabled enabled\n`
        : `Id=${name}\nLoadState=loaded\nNeedDaemonReload=${change === "reload" ? "yes" : "no"}\nFragmentPath=${fragmentPath}\n${change === "duplicate" ? `Id=${name}\n` : ""}`;
    return {
      stdout: change === "unknown" ? "unknown unit data\n" : stdout,
      stderr: "",
      code: 0,
      signal: null,
      timedOut: false,
    };
  });
  return { f, name, fragmentPath };
}

describe("read-only account manager reference inventory", () => {
  it("unions loaded and staged names then verifies current loaded definitions", async () => {
    const { f, name, fragmentPath } = await fixture();
    expect(await inspectLocalSupervisorServiceUnits(f.control)).toEqual([{ name, fragmentPath }]);
    expect(f.control.run).toHaveBeenCalledTimes(3);
    expect(
      vi
        .mocked(f.control.run)
        .mock.calls.every(([, script]) => !/\b(start|stop|enable|disable)\b/.test(script)),
    ).toBe(true);
  });
  it.each(["reload", "duplicate", "unknown"])("fails closed for %s metadata", async (change) => {
    const { f } = await fixture(change);
    await expect(inspectLocalSupervisorServiceUnits(f.control)).rejects.toThrow();
  });
});
