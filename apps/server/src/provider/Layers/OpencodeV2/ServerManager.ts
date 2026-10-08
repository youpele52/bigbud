import path from "node:path";
import { runWithAbortableDeadline } from "../../RequestDeadline.ts";
import { OPENCODE_V2_CLIENT_VERSION } from "./Compatibility.ts";
import { V2UnconfirmedProcessStartup, v2ProcessExited } from "./ServerManager.lifecycle.ts";

import { OpencodeV2EventHub, validateV2EventHubBounds } from "./EventHub.ts";
import {
  startOwnedV2Process,
  type OwnedV2Process,
  type V2ProcessConfig,
} from "./ServerManager.child.ts";

interface Entry {
  readonly storageKey: string;
  readonly generation: number;
  readonly started: Promise<OwnedV2Process>;
  references: number;
  process?: OwnedV2Process;
  hub?: OpencodeV2EventHub;
  closing?: boolean;
  startupSettled?: boolean;
  exclusive?: boolean;
  unsubscribe?: () => void;
}

export interface V2ProcessLease {
  readonly generation: number;
  readonly process: OwnedV2Process;
  readonly hub: OpencodeV2EventHub;
  readonly release: () => Promise<void>;
  /** Process-global MCP mutation requires a dedicated lease, excluding future siblings. */
  readonly claimExclusive: () => void;
}

/** Separate process/config namespace; coalesces acquisition without touching V1/Kilo. */
export class OpencodeV2ServerManager {
  private readonly entries = new Map<string, Entry>();
  private nextGeneration = 0;
  private closed = false;

  constructor(
    private readonly options: {
      readonly start?: (config: V2ProcessConfig) => Promise<OwnedV2Process>;
      readonly maxProcesses: number;
      readonly maxOwners: number;
      readonly maxQueuedEvents: number;
      readonly maxEventBytes: number;
      readonly consumerTimeoutMs: number;
    },
  ) {
    validateV2EventHubBounds(options);
    if (!Number.isSafeInteger(options.maxProcesses) || options.maxProcesses < 1)
      throw new Error("Invalid OpenCode v2 process bound.");
  }

  private remember(key: string, entry: Entry, process: OwnedV2Process) {
    if (entry.process) return;
    entry.process = process;
    const death = process.onDeath(() => {
      if (!v2ProcessExited(process)) return;
      if (this.entries.get(key) === entry) this.entries.delete(key);
      entry.unsubscribe?.();
      entry.hub?.markGap();
      void entry.hub?.close();
    });
    const unavailable = process.onUnavailable?.(() => {
      entry.closing = true;
      entry.hub?.markGap();
      void entry.hub?.close();
    });
    entry.unsubscribe = () => {
      death();
      unavailable?.();
    };
    if (v2ProcessExited(process)) entry.unsubscribe();
  }

  private forgetSettled(key: string, entry: Entry) {
    if (
      (!entry.process || v2ProcessExited(entry.process)) &&
      entry.startupSettled &&
      this.entries.get(key) === entry
    ) {
      this.entries.delete(key);
      entry.unsubscribe?.();
    }
  }

  async acquire(config: V2ProcessConfig): Promise<V2ProcessLease> {
    if (this.closed) throw new Error("OpenCode v2 manager is closed.");
    const resolvePath = config.runtimeTargetId === "local" ? path.resolve : path.posix.resolve;
    const key = JSON.stringify([
      config.runtimeTargetId,
      resolvePath(config.binaryPath),
      resolvePath(config.profileRoot),
      config.workspaceRoot ?? null,
    ]);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.options.maxProcesses)
        throw new Error("OpenCode v2 process capacity reached.");
      const storageKey = JSON.stringify([config.runtimeTargetId, resolvePath(config.profileRoot)]);
      if ([...this.entries.values()].some((existing) => existing.storageKey === storageKey)) {
        throw new Error("OpenCode v2 profile storage is already owned by another executable.");
      }
      const start = Promise.resolve().then(() =>
        (this.options.start ?? startOwnedV2Process)(config),
      );
      entry = {
        storageKey,
        generation: ++this.nextGeneration,
        references: 0,
        started: runWithAbortableDeadline({
          operation: "OpenCode v2 acquisition",
          timeoutMs: 20_000,
          run: () => start,
        }),
      };
      const pending = entry;
      void start
        .then(
          async (process) => {
            pending.startupSettled = true;
            this.remember(key, pending, process);
            if (this.closed || pending.closing || this.entries.get(key) !== pending) {
              try {
                await process.close();
              } finally {
                this.forgetSettled(key, pending);
              }
            }
          },
          (error) => {
            pending.startupSettled = true;
            if (error instanceof V2UnconfirmedProcessStartup) {
              pending.closing = true;
              this.remember(key, pending, error.process);
            }
            this.forgetSettled(key, pending);
          },
        )
        .catch(() => {});
      this.entries.set(key, entry);
    }
    if (entry.closing) throw new Error("OpenCode v2 process generation is closing.");
    if (entry.exclusive)
      throw new Error("OpenCode v2 process is reserved for an isolated tool owner.");
    const owned = entry;
    owned.references++;
    let process: OwnedV2Process;
    try {
      process = await owned.started;
    } catch (error) {
      owned.references--;
      owned.closing = true;
      this.forgetSettled(key, owned);
      if (
        error instanceof Error &&
        error.message ===
          `OpenCode v2 development requires CLI ${OPENCODE_V2_CLIENT_VERSION}; incompatible version rejected.`
      )
        throw error;
      throw new Error("OpenCode v2 process acquisition failed.", { cause: error });
    }
    if (this.closed || this.entries.get(key) !== owned || !process.isRunning()) {
      owned.references--;
      owned.closing = true;
      this.remember(key, owned, process);
      try {
        await process.close();
      } finally {
        this.forgetSettled(key, owned);
      }
      throw new Error("OpenCode v2 process generation is unavailable.");
    }
    if (!owned.hub) {
      this.remember(key, owned, process);
      const hub = new OpencodeV2EventHub({
        ...this.options,
        subscribe: (signal) => process.client.event.subscribe({ signal }),
      });
      owned.hub = hub;
      hub.start();
    }
    let released = false;
    return {
      generation: owned.generation,
      process,
      hub: owned.hub!,
      claimExclusive: () => {
        if (released || owned.references !== 1 || !process.isRunning())
          throw new Error("OpenCode v2 process is not exclusively owned.");
        owned.exclusive = true;
      },
      release: async () => {
        if (released) return;
        released = true;
        owned.references--;
        if (owned.references === 0) {
          owned.closing = true;
          try {
            await owned.hub?.close();
            await process.close();
          } finally {
            this.forgetSettled(key, owned);
          }
        }
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.entries.entries()].map(async ([key, entry]) => {
        entry.closing = true;
        await entry.hub?.close();
        // Late startup completion is disposed too, even if the first caller cancelled.
        await runWithAbortableDeadline({
          operation: "OpenCode v2 manager shutdown",
          timeoutMs: 5000,
          run: () =>
            entry.started.then(
              (process) => process.close(),
              () => {},
            ),
        }).catch(() => {});
        this.forgetSettled(key, entry);
      }),
    );
    if (this.entries.size)
      throw new Error(
        "OpenCode v2 manager shutdown remains unconfirmed; native namespaces retained.",
      );
  }
}
