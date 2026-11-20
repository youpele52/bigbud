import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  profileLaunch,
  profileOwner,
  spawnInput,
} from "./remoteAgentOwnedPty.profile.testUtils.ts";

const f = vi.hoisted(() => ({
  owned: vi.fn(),
  makeOwned: vi.fn(),
  get: vi.fn(),
  observe: vi.fn(),
  control: vi.fn(),
}));
vi.mock("./remoteAgentOwnedPty.ts", () => ({ makeOwnedRemoteAgentPty: f.makeOwned }));
vi.mock("./remoteAgentOwners.ts", () => ({ remoteAgentOwners: () => ({ get: f.get }) }));
vi.mock("./remoteAgentLegacyBinding.ts", () => ({ observeLegacyRemoteAgentBinding: f.observe }));
vi.mock("./remoteAgentControl.ts", () => ({ openRemoteAgentControl: f.control }));
import { makeRemoteAgentComposition } from "./remoteAgentComposition.ts";

beforeEach(() => {
  vi.resetAllMocks();
  f.makeOwned.mockReturnValue(f.owned);
  f.get.mockResolvedValue(undefined);
  f.owned.mockResolvedValue({ pid: 12 });
  f.control.mockResolvedValue({ root: "/remote/account" });
});

describe("ordinary custom-binary profile composition", () => {
  it("leaves new implicit ordinary terminals on their legacy path", async () => {
    const c = makeRemoteAgentComposition({ binaryPath: "/opt/custom/agent" });
    expect(c.managed).toBe(false);
    expect(await c.ptyResolver.restoreOrCreate!(spawnInput())).toBeUndefined();
    expect(f.owned).not.toHaveBeenCalled();
    expect(f.observe).not.toHaveBeenCalled();
  });

  it.each(["explicit", "recoverOnly", "retained-owner"])(
    "uses the shared durable owner service for %s",
    async (kind) => {
      const c = makeRemoteAgentComposition({ binaryPath: "/opt/custom/agent" });
      if (kind === "retained-owner") f.get.mockResolvedValue(profileOwner(profileLaunch()));
      const input = {
        ...spawnInput(kind === "explicit" ? profileLaunch() : undefined),
        ...(kind === "recoverOnly" ? { recoverOnly: true } : {}),
      };
      expect(await c.ptyResolver.restoreOrCreate!(input)).toEqual({ pid: 12 });
      expect(f.get).toHaveBeenCalledWith("terminal:pane");
      expect(f.owned).toHaveBeenCalledExactlyOnceWith(input);
      expect(f.observe).not.toHaveBeenCalled();
    },
  );

  it("resolves new profile admission against the configured custom binary without managed target selection", async () => {
    const c = makeRemoteAgentComposition({ binaryPath: "/opt/custom/agent" });
    const resolve = c.ptyResolver.resolveProfileBinding!;
    await resolve("ssh:target");
    expect(f.observe).toHaveBeenCalledWith(
      "ssh:target",
      { root: "/remote/account" },
      undefined,
      undefined,
      "/opt/custom/agent",
    );
    expect(f.makeOwned.mock.calls[0]?.[2]).toBe(resolve);
  });
});
