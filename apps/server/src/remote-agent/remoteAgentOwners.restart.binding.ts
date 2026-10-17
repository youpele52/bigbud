import type { RemoteAgentRuntimeBinding } from "./remoteAgentConnectionPool.ts";

export function restartFixtureBinding(generation: string): RemoteAgentRuntimeBinding {
  const sha256 = (generation === "g1" ? "a" : "b").repeat(64);
  return {
    expectedEpoch: `epoch-${generation}`,
    runtime: {
      generation,
      version: "0.2.207",
      sha256,
      buildDigest: "fixture",
      targetTriple: "aarch64-unknown-linux-gnu",
      origin: "managed",
      binaryPath: `/tmp/agent/bin/0.2.207/${sha256}/bigbud-remote-agent`,
      statePath: `/tmp/agent/runtimes/${generation}`,
      socketPath: `/tmp/agent/runtimes/${generation}/supervisor.sock`,
      logPath: `/tmp/agent/runtimes/${generation}/supervisor.log`,
    },
  };
}
