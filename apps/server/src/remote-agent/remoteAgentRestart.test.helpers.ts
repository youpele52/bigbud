import type {
  RemoteAgentRestartRecord,
  RemoteAgentRestartStore,
} from "./remoteAgentRestart.types.ts";

export function runtime(generation: string) {
  const sha = (generation === "g1" ? "a" : "b").repeat(64);
  return {
    generation,
    version: "0.2.207",
    sha256: sha,
    buildDigest: "digest",
    targetTriple: "x86_64-unknown-linux-gnu" as const,
    origin: "managed" as const,
    binaryPath: `/tmp/agent/bin/0.2.207/${sha}/bigbud-remote-agent`,
    statePath: `/tmp/agent/runtimes/${generation}`,
    socketPath: `/tmp/agent/runtimes/${generation}/supervisor.sock`,
    logPath: `/tmp/agent/runtimes/${generation}/supervisor.log`,
  };
}

export function store(): RemoteAgentRestartStore {
  const records = new Map<string, RemoteAgentRestartRecord>();
  return {
    get: async (id) => records.get(id),
    put: async (record) => {
      records.set(record.requestId, record);
    },
    update: async (id, transition) => {
      const current = records.get(id);
      if (!current) throw new Error("missing");
      const next = transition(current);
      records.set(id, next);
      return next;
    },
  };
}

export function restartRecord(
  overrides: Partial<RemoteAgentRestartRecord> = {},
): RemoteAgentRestartRecord {
  return {
    requestId: "restart-status",
    projectId: "project-status",
    target: "ssh:fixture",
    runtime: runtime("g1"),
    oldEpoch: "g1",
    phase: "stopping",
    message: "Stopping",
    ...overrides,
  };
}
