import type { RemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";
import type { MobileGatewayBinding } from "./mobileGatewayLifecycle.schema.ts";

/** Current CAS selection must match the independently authenticated canonical P4 binding. */
export function assertMobileGatewaySelectedBinding(
  state: RemoteAgentRegistry,
  binding: MobileGatewayBinding,
): void {
  const build = state.builds.find((entry) => entry.id === binding.buildId);
  if (
    !build ||
    state.current !== build.id ||
    !build.authenticated ||
    build.binary !== "present" ||
    build.health !== "healthy" ||
    build.runtime.generation !== binding.generation ||
    !state.launches.some(
      (entry) =>
        entry.buildId === build.id && entry.phase === "ready" && entry.epoch === binding.epoch,
    ) ||
    (state.currentConnectionId !== null && state.currentConnectionId !== binding.connectionId)
  )
    throw Error("Gateway publication or canonical agent binding changed.");
}
