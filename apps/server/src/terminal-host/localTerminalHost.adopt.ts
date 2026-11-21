import * as fs from "node:fs/promises";

import type { RemoteAgentRuntimeBinding } from "../remote-agent/remoteAgentConnectionPool.ts";
import {
  localTerminalHostGenerationPaths,
  localTerminalHostSocketPathTooLong,
  parseLocalTerminalHostGeneration,
  type LocalTerminalHostGenerationPaths,
  type LocalTerminalHostPaths,
} from "./localTerminalHost.paths.ts";
import type { LocalTerminalHostProbe } from "./localTerminalHost.probe.ts";
import type { LocalTerminalHostProcesses } from "./localTerminalHost.process.ts";
import {
  removeLocalTerminalHostRecord,
  upsertLocalTerminalHostRecord,
  type LocalTerminalHostRecord,
  type LocalTerminalHostRegistry,
} from "./localTerminalHost.registry.ts";
import {
  localTerminalHostBinding,
  type LocalTerminalHostHello,
} from "./localTerminalHost.transport.ts";

const STOP_WAIT_MS = 3_000;

export interface LocalTerminalHostAdoptionDeps {
  readonly paths: LocalTerminalHostPaths;
  readonly registry: LocalTerminalHostRegistry;
  readonly probe: (generation: LocalTerminalHostGenerationPaths) => Promise<LocalTerminalHostProbe>;
  readonly generationHasOwners: (
    connectionId: string,
    epoch: string | undefined,
  ) => Promise<boolean | undefined>;
  readonly processes: LocalTerminalHostProcesses;
  readonly requiredCapabilities: ReadonlyArray<string>;
  /** Runtime descriptor path for a host found without a record. */
  readonly binaryPathFor: (buildDigest: string) => string;
  readonly log: (message: string, detail?: Record<string, unknown>) => void;
  readonly now?: () => number;
}

/** A reachable protocol-major-1 host. Its owners reattach through `binding` (F2). */
export interface LocalTerminalHostAttachedGeneration {
  readonly generation: LocalTerminalHostGenerationPaths;
  readonly hello: LocalTerminalHostHello;
  readonly binding: RemoteAgentRuntimeBinding;
  /** Has every required capability; only a capable host can be admitted. */
  readonly capable: boolean;
}

/** A live-or-unknown host that cannot serve new terminals and must never be killed silently. */
export interface LocalTerminalHostDrainingNotice {
  readonly generation: number;
  readonly reason: "unreachable" | "incompatible";
  /** The one-time amber toast has not yet been raised for this generation. */
  readonly firstTime: boolean;
  /** "Close them" is offered only when the PID can be verified. */
  readonly canClose: boolean;
}

export interface LocalTerminalHostAdoption {
  /** The newest capable generation; it receives new terminals. */
  readonly admitted: LocalTerminalHostAttachedGeneration | undefined;
  readonly attached: ReadonlyArray<LocalTerminalHostAttachedGeneration>;
  readonly notices: ReadonlyArray<LocalTerminalHostDrainingNotice>;
  readonly highestGeneration: number;
  readonly socketPathTooLong: boolean;
}

export function supportsLocalTerminalHostCapabilities(
  hello: Pick<LocalTerminalHostHello, "capabilities">,
  required: ReadonlyArray<string>,
): boolean {
  return required.every((name) =>
    hello.capabilities.some((capability) => capability.name === name && capability.major === 1),
  );
}

async function discoverGenerations(root: string): Promise<ReadonlyArray<number>> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.flatMap((entry) => {
      const generation = entry.isDirectory()
        ? parseLocalTerminalHostGeneration(entry.name)
        : undefined;
      return generation === undefined ? [] : [generation];
    });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
}

/**
 * Stops a host only when it is proven empty: no durable owners for its connectionId and epoch,
 * a PID verified by start time, and no OS child processes. Unknown is always live.
 */
export async function stopLocalTerminalHostIfProvenEmpty(
  deps: Pick<LocalTerminalHostAdoptionDeps, "generationHasOwners" | "processes" | "log">,
  generation: LocalTerminalHostGenerationPaths,
  identity: {
    readonly epoch?: string | undefined;
    readonly pid?: number | undefined;
    readonly pidStartTime?: number | undefined;
  },
): Promise<boolean> {
  if ((await deps.generationHasOwners(generation.name, identity.epoch)) !== false) return false;
  if ((await deps.processes.verify(identity.pid, identity.pidStartTime)) !== "verified")
    return false;
  const pid = identity.pid!;
  if ((await deps.processes.hasChildren(pid)) !== false) return false;
  deps.log("Stopping an empty local terminal host.", { generation: generation.name, pid });
  if (!deps.processes.signal(pid, "SIGTERM")) return false;
  return deps.processes.waitForExit(pid, STOP_WAIT_MS);
}

function helloIdentity(
  hello: LocalTerminalHostHello,
  record: LocalTerminalHostRecord | undefined,
): { readonly pid?: number; readonly pidStartTime?: number } {
  if (hello.processId !== undefined && hello.processId > 1)
    return {
      pid: hello.processId,
      ...(hello.processStartTimeMs !== undefined ? { pidStartTime: hello.processStartTimeMs } : {}),
    };
  // Without the R4 hello fields, only a record from this same host instance names its PID.
  if (
    record?.pid !== undefined &&
    (record.epoch === hello.agentEpoch || record.state === "launching")
  )
    return {
      pid: record.pid,
      ...(record.pidStartTime !== undefined ? { pidStartTime: record.pidStartTime } : {}),
    };
  return {};
}

/** Adoption never launches and never uses `--prepare-supervisor` (plan §7.3 items 4 to 6). */
export async function adoptLocalTerminalHosts(
  deps: LocalTerminalHostAdoptionDeps,
): Promise<LocalTerminalHostAdoption> {
  const now = deps.now ?? Date.now;
  const records = await deps.registry.read();
  const byGeneration = new Map(records.map((record) => [record.generation, record]));
  const generations = [
    ...new Set([...(await discoverGenerations(deps.paths.root)), ...byGeneration.keys()]),
  ].toSorted((left, right) => left - right);
  const highestGeneration = generations.at(-1) ?? 0;
  const tooLong = localTerminalHostSocketPathTooLong(
    localTerminalHostGenerationPaths(deps.paths.root, Math.max(1, highestGeneration)).socketPath,
  );
  const writes = new Map<number, LocalTerminalHostRecord | null>();
  const attached: Array<LocalTerminalHostAttachedGeneration & { record: LocalTerminalHostRecord }> =
    [];
  const notices: Array<LocalTerminalHostDrainingNotice> = [];

  for (const number of generations) {
    const generation = localTerminalHostGenerationPaths(deps.paths.root, number);
    const record = byGeneration.get(number);
    if (localTerminalHostSocketPathTooLong(generation.socketPath)) {
      deps.log("Local terminal host socket path is too long; skipping.", {
        generation: generation.name,
      });
      continue;
    }
    const probe = await deps.probe(generation);
    if (probe.kind === "gone") {
      if (record) writes.set(number, null);
      continue;
    }
    if (probe.kind === "insecure") {
      deps.log("Refusing an insecure local terminal host socket.", {
        generation: generation.name,
        reason: probe.reason,
      });
      continue;
    }
    if (probe.kind === "hello") {
      const hello = probe.hello;
      const binaryPath = record?.binaryPath || deps.binaryPathFor(hello.buildDigest);
      let binding: RemoteAgentRuntimeBinding | undefined;
      try {
        binding = localTerminalHostBinding(generation, hello, binaryPath);
      } catch (cause) {
        deps.log("Local terminal host identity is not representable.", {
          generation: generation.name,
          cause: String(cause),
        });
      }
      if (binding) {
        const identity = helloIdentity(hello, record);
        const next: LocalTerminalHostRecord = {
          generation: number,
          state: "running",
          binaryPath,
          agentVersion: hello.agentVersion,
          buildDigest: hello.buildDigest,
          protocolMajor: hello.protocolMajor,
          protocolMinor: hello.protocolMinor,
          capabilities: hello.capabilities.map((capability) => capability.name),
          epoch: hello.agentEpoch,
          ...identity,
          launchedAt: record?.launchedAt ?? now(),
        };
        const capable = supportsLocalTerminalHostCapabilities(hello, deps.requiredCapabilities);
        attached.push({ generation, hello, binding, capable, record: next });
        continue;
      }
    }
    const reason = probe.kind === "incompatible" ? "incompatible" : "unreachable";
    if (await stopLocalTerminalHostIfProvenEmpty(deps, generation, record ?? {})) {
      writes.set(number, null);
      continue;
    }
    const canClose =
      (await deps.processes.verify(record?.pid, record?.pidStartTime)) === "verified";
    notices.push({
      generation: number,
      reason,
      firstTime: record?.drainingNoticeRaised !== true,
      canClose,
    });
    writes.set(number, {
      ...(record ?? { generation: number, binaryPath: "", capabilities: [], launchedAt: now() }),
      state: "draining",
      drainingNoticeRaised: true,
    });
  }

  const admitted = attached.findLast((entry) => entry.capable);
  const kept: Array<LocalTerminalHostAttachedGeneration> = [];
  for (const entry of attached) {
    const { record, ...generation } = entry;
    if (
      entry !== admitted &&
      (await stopLocalTerminalHostIfProvenEmpty(deps, entry.generation, record))
    ) {
      writes.set(record.generation, null);
      continue;
    }
    writes.set(record.generation, {
      ...record,
      state: entry === admitted ? "running" : "draining",
    });
    kept.push(generation);
  }
  if (writes.size > 0)
    await deps.registry.update((current) => {
      let next = current;
      for (const [generation, record] of writes)
        next = record
          ? upsertLocalTerminalHostRecord(next, record)
          : removeLocalTerminalHostRecord(next, generation);
      return next;
    });
  return {
    admitted: kept.find((entry) => entry.generation.generation === admitted?.generation.generation),
    attached: kept,
    notices,
    highestGeneration,
    socketPathTooLong: tooLong,
  };
}
