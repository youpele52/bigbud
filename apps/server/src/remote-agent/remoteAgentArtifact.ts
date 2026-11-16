export {
  REMOTE_AGENT_SUPPORTED_PROTOCOL_MAJOR,
  RemoteAgentArtifactError,
  REMOTE_AGENT_TARGET_TRIPLES,
  canonicalizeRemoteAgentArtifact,
  isRemoteAgentMuslTarget,
  isRemoteAgentTargetTriple,
  parseRemoteAgentArtifactManifest,
  remoteAgentTargetArchitecture,
  remoteAgentTargetCandidates,
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
  RemoteAgentHostLibc,
  RemoteAgentTargetArchitecture,
  RemoteAgentTargetTriple,
} from "@bigbud/shared/remoteAgentArtifact";
