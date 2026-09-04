import { EventId, type ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

export function makeAcpStartSessionTestDeps<SessionContext>(input: {
  readonly stateDir: string;
  readonly sessions: Map<ThreadId, SessionContext>;
}) {
  return {
    childProcessSpawner: {} as ChildProcessSpawner.ChildProcessSpawner["Service"],
    nativeEventLogger: undefined,
    remoteAgentPtyResolver: undefined,
    remoteWorkspaceReadinessProbe: async () => ({ os: "linux" as const, architecture: "x86_64" }),
    serverConfig: {
      stateDir: input.stateDir,
      host: "127.0.0.1" as const,
      port: 3773,
    },
    sessions: input.sessions,
    stopSessionInternal: () => Effect.void,
    makeEventStamp: () =>
      Effect.succeed({
        eventId: EventId.makeUnsafe("evt-acp-start-session"),
        createdAt: "2026-06-30T00:00:00.000Z",
      }),
    offerRuntimeEvent: () => Effect.void,
    nowIso: Effect.succeed("2026-06-30T00:00:00.000Z"),
  };
}

export async function readOrchestrationMcpServerSource(
  mcpServers: ReadonlyArray<{ readonly args?: ReadonlyArray<string> }> | undefined,
): Promise<string | undefined> {
  const serverPath = mcpServers?.[0]?.args?.[0];
  if (!serverPath) {
    return undefined;
  }
  const fs = await import("node:fs/promises");
  return fs.readFile(serverPath, "utf8");
}
