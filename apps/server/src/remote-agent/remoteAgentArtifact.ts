export {
  REMOTE_AGENT_SUPPORTED_PROTOCOL_MAJOR,
  RemoteAgentArtifactError,
  canonicalizeRemoteAgentArtifact,
  parseRemoteAgentArtifactManifest,
  resolveRemoteAgentTargetTriple,
  selectRemoteAgentArtifact,
  verifyRemoteAgentArtifactBytes,
  verifyRemoteAgentArtifactSignature,
} from "@bigbud/shared/remoteAgentArtifact";
export type {
  RemoteAgentArtifact,
  RemoteAgentArtifactManifest,
  RemoteAgentArtifactSignature,
  RemoteAgentArtifactTrustStore,
  RemoteAgentTargetTriple,
} from "@bigbud/shared/remoteAgentArtifact";
