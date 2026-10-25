import { expect, it, vi } from "vitest";
import { detectPiSettlementSupport, piVersionCapabilities } from "./RpcProcess.capabilities.ts";
import type { PiRpcProcessOptions } from "./RpcProcess.types.ts";

it.each([
  ["0.80.3", false, false],
  ["0.80.4", true, false],
  ["0.81.0", true, false],
  ["0.98.9", true, false],
  ["0.99.0", true, true],
  ["pi v1.4.0", true, true],
  ["2.0.0", true, true],
])("detects independent capabilities in %s", (version, settled, disposition) => {
  expect(piVersionCapabilities(String(version))).toEqual({
    supportsAgentSettled: settled,
    supportsPromptDisposition: disposition,
  });
});

it.each(["local", "remote"] as const)(
  "probes the selected %s runtime, not migration eligibility",
  async (location) => {
    const options: PiRpcProcessOptions = {
      binaryPath: location === "local" ? "/custom/pi" : "pi",
      providerRuntimeTarget:
        location === "local"
          ? { location: "local", executionTargetId: "local" }
          : { location: "remote", executionTargetId: "ssh:host=devbox&user=root&port=22" },
      workspaceTarget: { location: "local", executionTargetId: "local", cwd: "/workspace" },
      env: { TEST: "isolated" },
    };
    const run = vi.fn(async () => ({ stdout: "1.4.0\n" }));
    expect(await detectPiSettlementSupport(options, run)).toEqual({
      supportsAgentSettled: true,
      supportsPromptDisposition: true,
    });
    expect(run).toHaveBeenCalledOnce();
    const [command, args, config] = run.mock.calls[0] as unknown as [string, string[], object];
    expect(command).toBe(location === "local" ? "/custom/pi" : "ssh");
    expect(args.join(" ")).toContain("--version");
    if (location === "remote") expect(args.join(" ")).toContain("pi");
    expect(config).toMatchObject({ env: options.env, timeout: 5000, maxBuffer: 4096 });
    run.mockResolvedValue({ stdout: "0.80.3\n" });
    expect(await detectPiSettlementSupport(options, run)).toEqual({
      supportsAgentSettled: false,
      supportsPromptDisposition: false,
    });
    run.mockResolvedValue({ stdout: "0.98.0\n" });
    expect(await detectPiSettlementSupport(options, run)).toEqual({
      supportsAgentSettled: true,
      supportsPromptDisposition: false,
    });
    run.mockResolvedValue({ stdout: "not a version" });
    await expect(detectPiSettlementSupport(options, run)).rejects.toThrow("Failed to determine");
  },
);
