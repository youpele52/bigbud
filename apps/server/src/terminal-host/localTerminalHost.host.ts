import * as fs from "node:fs/promises";

import type { RemoteAgentRuntimeBinding } from "../remote-agent/remoteAgentConnectionPool.ts";
import type { RemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";
import {
  adoptLocalTerminalHosts,
  type LocalTerminalHostAdoption,
  type LocalTerminalHostAdoptionDeps,
  type LocalTerminalHostAttachedGeneration,
  type LocalTerminalHostDrainingNotice,
} from "./localTerminalHost.adopt.ts";
import type { StagedLocalTerminalHostBinary } from "./localTerminalHost.binary.ts";
import { launchLocalTerminalHostGeneration } from "./localTerminalHost.host.launch.ts";
import {
  localTerminalHostStagedBinaryPath,
  type LocalTerminalHostMode,
} from "./localTerminalHost.paths.ts";
import { removeLocalTerminalHostRecord } from "./localTerminalHost.registry.ts";

const LAUNCH_RETRY_COOLDOWN_MS = 30_000;
const CLOSE_WAIT_MS = 3_000;

export interface LocalTerminalHostControllerDeps extends Omit<
  LocalTerminalHostAdoptionDeps,
  "probe" | "binaryPathFor"
> {
  readonly mode: LocalTerminalHostMode;
  readonly stage: () => Promise<StagedLocalTerminalHostBinary>;
  readonly verifyStaged: (staged: StagedLocalTerminalHostBinary) => Promise<void>;
  readonly collectRuntimes: (keepDigests: Iterable<string>) => Promise<ReadonlyArray<string>>;
  readonly probe: (
    generation: Parameters<LocalTerminalHostAdoptionDeps["probe"]>[0],
    proxyBinary: string,
  ) => ReturnType<LocalTerminalHostAdoptionDeps["probe"]>;
  readonly launch: (input: {
    readonly binaryPath: string;
    readonly generation: Parameters<LocalTerminalHostAdoptionDeps["probe"]>[0];
  }) => Promise<{ readonly pid: number }>;
  readonly prepareGeneration: (
    generation: Parameters<LocalTerminalHostAdoptionDeps["probe"]>[0],
  ) => Promise<void>;
}

export interface LocalTerminalHostController {
  readonly mode: LocalTerminalHostMode;
  /** One adoption pass per backend; never launches. */
  readonly ready: () => Promise<LocalTerminalHostAdoption>;
  /** The admitted generation's binding, launching a fresh generation when needed (enabled mode). */
  readonly resolveAdmittedBinding: () => Promise<RemoteAgentRuntimeBinding | undefined>;
  /** The admitted, live generation's binding; never launches (host-wide controls, policy). */
  readonly currentAdmittedBinding: () => Promise<RemoteAgentRuntimeBinding | undefined>;
  readonly knownRuntimes: () => Promise<ReadonlyArray<RemoteAgentRuntime>>;
  /** Every attached generation's binding (admitted and draining); never launches. */
  readonly attachedBindings: () => Promise<
    ReadonlyArray<{
      readonly generation: number;
      readonly binding: RemoteAgentRuntimeBinding;
      readonly admitted: boolean;
    }>
  >;
  readonly proxyBinary: () => Promise<string>;
  readonly notices: () => ReadonlyArray<LocalTerminalHostDrainingNotice>;
  /** User-confirmed "Close them": SIGTERM only a start-time-verified PID. */
  readonly closeDrainingHost: (generation: number) => Promise<void>;
}

export function makeLocalTerminalHostController(
  deps: LocalTerminalHostControllerDeps,
): LocalTerminalHostController {
  const now = deps.now ?? Date.now;
  let adoption: Promise<LocalTerminalHostAdoption> | undefined;
  let staging: Promise<StagedLocalTerminalHostBinary> | undefined;
  let launching: Promise<RemoteAgentRuntimeBinding | undefined> | undefined;
  let admitted: LocalTerminalHostAttachedGeneration | undefined;
  let highestGeneration = 0;
  let launchBlockedUntil = 0;
  const attached = new Map<number, LocalTerminalHostAttachedGeneration>();
  let notices: ReadonlyArray<LocalTerminalHostDrainingNotice> = [];

  const stage = () => {
    staging ??= deps.stage().catch((cause: unknown) => {
      staging = undefined;
      throw cause;
    });
    return staging;
  };

  const proxyBinary = async (): Promise<string> => {
    try {
      return (await stage()).path;
    } catch (cause) {
      // Kill-switch adoption may run without a packaged binary; a retained runtime still proxies.
      for (const record of (await deps.registry.read()).toReversed()) {
        if (!record.binaryPath) continue;
        if (
          await fs.access(record.binaryPath, fs.constants.X_OK).then(
            () => true,
            () => false,
          )
        )
          return record.binaryPath;
      }
      throw cause;
    }
  };

  const ready = () => {
    adoption ??= (async () => {
      const proxy = await proxyBinary();
      const result = await adoptLocalTerminalHosts({
        ...deps,
        probe: (generation) => deps.probe(generation, proxy),
        binaryPathFor: (buildDigest) => localTerminalHostStagedBinaryPath(deps.paths, buildDigest),
      });
      highestGeneration = Math.max(highestGeneration, result.highestGeneration);
      for (const entry of result.attached) attached.set(entry.generation.generation, entry);
      admitted = result.admitted;
      notices = result.notices;
      for (const notice of result.notices.filter((entry) => entry.firstTime))
        deps.log("A local terminal host cannot take new terminals and was left running.", {
          generation: notice.generation,
          reason: notice.reason,
          canClose: notice.canClose,
        });
      const staged = await stage().catch(() => undefined);
      const records = await deps.registry.read();
      const keep = records.flatMap((record) => (record.buildDigest ? [record.buildDigest] : []));
      if (staged) {
        const removed = await deps.collectRuntimes([...keep, staged.check.buildDigest]);
        if (removed.length > 0) deps.log("Removed unused terminal host runtimes.", { removed });
      }
      return result;
    })().catch((cause: unknown) => {
      adoption = undefined;
      throw cause;
    });
    return adoption;
  };

  const admittedAlive = async (entry: LocalTerminalHostAttachedGeneration) => {
    try {
      if (!(await fs.lstat(entry.generation.socketPath)).isSocket()) return false;
    } catch {
      return false;
    }
    const pid =
      entry.hello.processId ??
      (await deps.registry.read()).find(
        (record) => record.generation === entry.generation.generation,
      )?.pid;
    return pid === undefined || deps.processes.isAlive(pid);
  };

  const launchFresh = async (): Promise<RemoteAgentRuntimeBinding | undefined> => {
    if (now() < launchBlockedUntil) return undefined;
    const records = await deps.registry.read();
    const generationNumber =
      Math.max(highestGeneration, ...records.map((record) => record.generation)) + 1;
    highestGeneration = generationNumber;
    const launched = await launchLocalTerminalHostGeneration(deps, {
      generationNumber,
      stage,
      previousAdmitted: admitted?.generation.generation,
    });
    if (!launched) {
      launchBlockedUntil = now() + LAUNCH_RETRY_COOLDOWN_MS;
      return undefined;
    }
    attached.set(generationNumber, launched);
    admitted = launched;
    return launched.binding;
  };

  return {
    mode: deps.mode,
    ready,
    proxyBinary,
    notices: () => notices,
    knownRuntimes: async () => {
      await ready().catch(() => undefined);
      return [...attached.values()].map((entry) => entry.binding.runtime);
    },
    attachedBindings: async () => {
      await ready().catch(() => undefined);
      return [...attached.values()].map((entry) => ({
        generation: entry.generation.generation,
        binding: entry.binding,
        admitted: entry === admitted,
      }));
    },
    currentAdmittedBinding: async () => {
      await ready().catch(() => undefined);
      const current = admitted;
      return current && (await admittedAlive(current)) ? current.binding : undefined;
    },
    resolveAdmittedBinding: async () => {
      if (deps.mode !== "enabled") return undefined;
      await ready().catch((cause: unknown) => {
        deps.log("Local terminal host adoption failed.", { cause: String(cause) });
      });
      if (admitted && (await admittedAlive(admitted))) return admitted.binding;
      if (admitted) {
        deps.log("The admitted local terminal host is gone; a fresh host starts on demand.", {
          generation: admitted.generation.name,
        });
        const lost = admitted.generation.generation;
        attached.delete(lost);
        admitted = undefined;
        await deps.registry.update((records) => removeLocalTerminalHostRecord(records, lost));
      }
      launching ??= launchFresh().finally(() => {
        launching = undefined;
      });
      return launching;
    },
    closeDrainingHost: async (generation) => {
      const record = (await deps.registry.read()).find((entry) => entry.generation === generation);
      if (!record || record.state !== "draining" || record.pid === undefined)
        throw new Error("This terminal host cannot be identified safely; it was left running.");
      if ((await deps.processes.verify(record.pid, record.pidStartTime)) !== "verified")
        throw new Error("This terminal host's process could not be verified; it was left running.");
      if (!deps.processes.signal(record.pid, "SIGTERM"))
        throw new Error("The terminal host did not accept the close request.");
      if (await deps.processes.waitForExit(record.pid, CLOSE_WAIT_MS)) {
        await deps.registry.update((records) => removeLocalTerminalHostRecord(records, generation));
        notices = notices.filter((notice) => notice.generation !== generation);
      }
    },
  };
}
