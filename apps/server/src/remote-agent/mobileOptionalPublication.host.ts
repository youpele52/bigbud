import { REMOTE_BACKEND_MOBILE_RPC_REVISION } from "@bigbud/contracts/server/remoteBackendHandshake";
import type { MobileOptionalArtifact } from "@bigbud/contracts/server/mobileOptionalArtifact";
import { version } from "../../package.json" with { type: "json" };
import type { RemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";

/** Shared pre-download/current-publication policy; no process readiness or signature authority. */
export function mobileOptionalPublicationHost(
  state: RemoteAgentRegistry,
  gateway: MobileOptionalArtifact,
) {
  const build = state.builds.find((entry) => entry.id === state.current);
  const arch =
    process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : "unsupported";
  if (
    !build?.authenticated ||
    build.binary !== "present" ||
    build.health !== "healthy" ||
    !build.runtime.targetTriple.startsWith(`${arch}-unknown-linux-`) ||
    !state.launches.some(
      (entry) => entry.buildId === build.id && entry.phase === "ready" && entry.epoch,
    ) ||
    gateway.kind !== "mobile-gateway" ||
    (gateway.targetTriple !== build.runtime.targetTriple &&
      gateway.targetTriple !== `${arch}-unknown-linux-musl`)
  )
    throw Error(
      "Mobile publication requires the current authenticated compatible Linux base runtime.",
    );
  return {
    targetTriple: gateway.targetTriple,
    agentVersion: build.runtime.version,
    backendVersion: version,
    mobileRpcRevision: REMOTE_BACKEND_MOBILE_RPC_REVISION,
  };
}
