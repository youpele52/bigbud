import type { LocalTerminalHostAttachedGeneration } from "./localTerminalHost.adopt.ts";
import { supportsLocalTerminalHostCapabilities } from "./localTerminalHost.adopt.ts";
import type { StagedLocalTerminalHostBinary } from "./localTerminalHost.binary.ts";
import type { LocalTerminalHostControllerDeps } from "./localTerminalHost.host.ts";
import {
  localTerminalHostGenerationPaths,
  localTerminalHostSocketPathTooLong,
} from "./localTerminalHost.paths.ts";
import {
  removeLocalTerminalHostRecord,
  upsertLocalTerminalHostRecord,
  type LocalTerminalHostRecord,
} from "./localTerminalHost.registry.ts";
import { localTerminalHostBinding } from "./localTerminalHost.transport.ts";

/**
 * Starts a fresh host in `state-<n>`: provisional record, private directory, verified staged
 * binary, detached launch, socket poll, hello, then the final record. A fresh host that fails
 * any check holds no terminals, so it is stopped by its spawn PID. Returns `undefined` when no
 * host can be started; new terminals then use the in-process fallback.
 */
export async function launchLocalTerminalHostGeneration(
  deps: LocalTerminalHostControllerDeps,
  input: {
    readonly generationNumber: number;
    readonly stage: () => Promise<StagedLocalTerminalHostBinary>;
    readonly previousAdmitted: number | undefined;
  },
): Promise<LocalTerminalHostAttachedGeneration | undefined> {
  const now = deps.now ?? Date.now;
  const generation = localTerminalHostGenerationPaths(deps.paths.root, input.generationNumber);
  if (localTerminalHostSocketPathTooLong(generation.socketPath)) {
    deps.log("Local terminal host socket path is too long; using in-process terminals.", {
      socketPath: generation.socketPath,
      bytes: Buffer.byteLength(generation.socketPath),
    });
    return undefined;
  }
  let staged: StagedLocalTerminalHostBinary;
  try {
    staged = await input.stage();
  } catch (cause) {
    deps.log("The terminal host binary is unavailable; using in-process terminals.", {
      cause: String(cause),
    });
    return undefined;
  }
  const provisional: LocalTerminalHostRecord = {
    generation: input.generationNumber,
    state: "launching",
    binaryPath: staged.path,
    agentVersion: staged.check.version,
    buildDigest: staged.check.buildDigest,
    protocolMajor: staged.check.protocolMajor,
    protocolMinor: staged.check.protocolMinor,
    capabilities: [],
    launchedAt: now(),
  };
  const forget = () =>
    deps.registry.update((records) =>
      removeLocalTerminalHostRecord(records, input.generationNumber),
    );
  let pid: number | undefined;
  try {
    await deps.registry.update((records) => upsertLocalTerminalHostRecord(records, provisional));
    await deps.prepareGeneration(generation);
    await deps.verifyStaged(staged);
    pid = (await deps.launch({ binaryPath: staged.path, generation })).pid;
    const probe = await deps.probe(generation, staged.path);
    if (probe.kind !== "hello") throw new Error(`Fresh terminal host probe: ${probe.kind}`);
    const hello = probe.hello;
    if (hello.processId !== undefined && hello.processId !== pid)
      throw new Error("Fresh terminal host reported another process identity.");
    if (!supportsLocalTerminalHostCapabilities(hello, deps.requiredCapabilities))
      throw new Error("Fresh terminal host lacks required capabilities.");
    const pidStartTime = hello.processStartTimeMs ?? (await deps.processes.startTime(pid));
    const binding = localTerminalHostBinding(generation, hello, staged.path);
    await deps.registry.update((records) => {
      let next = upsertLocalTerminalHostRecord(records, {
        ...provisional,
        state: "running",
        agentVersion: hello.agentVersion,
        buildDigest: hello.buildDigest,
        protocolMajor: hello.protocolMajor,
        protocolMinor: hello.protocolMinor,
        capabilities: hello.capabilities.map((capability) => capability.name),
        epoch: hello.agentEpoch,
        pid,
        ...(typeof pidStartTime === "number" ? { pidStartTime } : {}),
      });
      const previous = next.find((record) => record.generation === input.previousAdmitted);
      if (previous) next = upsertLocalTerminalHostRecord(next, { ...previous, state: "draining" });
      return next;
    });
    deps.log("Started a local terminal host.", { generation: generation.name, pid });
    return { generation, hello, binding, capable: true };
  } catch (cause) {
    deps.log("The local terminal host could not start; using in-process terminals.", {
      generation: generation.name,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
    if (pid !== undefined) {
      deps.processes.signal(pid, "SIGTERM");
      await deps.processes.waitForExit(pid, 3_000);
    }
    await forget().catch(() => undefined);
    return undefined;
  }
}
