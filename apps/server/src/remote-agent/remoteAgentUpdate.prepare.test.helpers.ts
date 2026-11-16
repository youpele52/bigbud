import { artifact } from "./remoteAgentInstallManager.fixtures.ts";

export function candidateHello() {
  return {
    protocolMajor: 1,
    protocolMinor: 2,
    agentVersion: artifact.version,
    buildDigest: artifact.buildDigest,
    os: "linux",
    architecture: "aarch64",
    agentInstanceId: "candidate",
    agentEpoch: "candidate-epoch",
    capabilities: [
      "diagnostic",
      "workspace.files",
      "workspace.search",
      "workspace.write",
      "workspace.watch",
      "process.run",
      "process.attach",
      "terminal.pty",
    ].map((name) => ({ name, major: 1, minor: 0 })),
    maxFrameBytes: 1024,
    maxOperationOutputBytes: 1024,
    maxJournalBytes: 1024,
  };
}
