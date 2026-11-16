import { vi } from "vitest";
import { remoteAgentBuildId } from "./remoteAgentRuntime.ts";
const probeWiring = vi.hoisted(() => ({ unavailable: false }));
export const gatewayChildProbeWiring = probeWiring;
// Synthetic comparable token isolates macOS sandbox process inspection; Linux proof uses real /proc.
vi.mock("@bigbud/shared/processStartToken", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bigbud/shared/processStartToken")>();
  return {
    ...actual,
    processStartToken: (pid: number) =>
      probeWiring.unavailable ? undefined : `${actual.PROCESS_START_TOKEN_PREFIX}test:owned-${pid}`,
  };
});
// Boundary tests isolate the live diagnostic; binding.test exercises the production P4 probe.
vi.mock("./mobileGatewayLifecycle.binding.ts", () => ({
  currentMobileGatewayBinding: async (
    authority: {
      registry: () => {
        read: () => Promise<import("./remoteAgentInstall.registry.ts").RemoteAgentRegistry>;
      };
    },
    owners: import("./remoteAgentOwners.ts").RemoteAgentOwnerStore,
  ) => {
    const binding = await owners.getBinding("fixture");
    if (!binding?.connectionId) throw new Error("fixture canonical binding absent");
    const state = await authority.registry().read();
    if (
      !state.builds.some(
        (b) => b.id === state.current && b.runtime.generation === binding.runtime.generation,
      )
    )
      throw new Error("fixture live binding changed");
    return {
      buildId: remoteAgentBuildId(binding.runtime),
      generation: binding.runtime.generation,
      epoch: binding.expectedEpoch,
      connectionId: binding.connectionId,
    };
  },
}));
