import { Effect, FileSystem } from "effect";
import { vi } from "vitest";

import { RemoteAgentPtyLimitError } from "../../remote-agent/remoteAgentPtyClient.types.ts";
import { profileOwner } from "../../remote-agent/remoteAgentOwnedPty.profile.testUtils.ts";
import type { RemoteAgentHostPolicy } from "../../remote-agent/remoteAgentProtocol.ptyLifecycle.ts";
import { TerminalViewRegistry } from "../activity/terminalViewRegistry.ts";
import type {
  OwnedPtyDrainingHostNotice,
  OwnedPtyHostGenerationReplay,
  OwnedPtyHostGenerations,
  OwnedPtyHostInventoryEntry,
  OwnedPtyRuntime,
} from "../Services/OwnedPtyRuntime.ts";
import {
  PtySpawnError,
  type PtyHostActivity,
  type PtyHostCapabilities,
  type PtyHostLifecycleNotice,
  type PtyScreenSnapshot,
  type PtyScreenSnapshotInput,
  type PtySequencedData,
  type PtySpawnInput,
  type PtyViewState,
} from "../Services/PTY.ts";
import { makeTerminalManagerWithOptions } from "./Manager.process.ts";
import { ownedRuntimeFixture } from "./Manager.owned-runtime.test.helpers.ts";
import { FakePtyAdapter, FakePtyProcess } from "./Manager.test.helpers.ts";
import type { TerminalManagerOptions } from "./Manager.types.ts";

export const ALL_CAPABILITIES: PtyHostCapabilities = {
  screen: true,
  lifecycle: true,
  spool: true,
  queryResponder: true,
  localLaunch: true,
};

const encoder = new TextEncoder();

/** A host PTY: sequenced output, screen copies, lifecycle controls. */
export class FakeHostProcess extends FakePtyProcess {
  sequence = 0;
  interruptionReason: string | undefined;
  readonly snapshotRequests: PtyScreenSnapshotInput[] = [];
  readonly viewStates: PtyViewState[] = [];
  keepOpenCalls = 0;
  /** The next snapshot's screen text and the sequence it covers (defaults to the current one). */
  screenText = "SCREEN";
  snapshotThrough: number | undefined;
  snapshotGate: Promise<void> | undefined;
  readonly sequenced = new Set<(event: PtySequencedData) => void>();
  readonly activityListeners = new Set<(activity: PtyHostActivity) => void>();
  readonly noticeListeners = new Set<(notice: PtyHostLifecycleNotice) => void>();

  constructor(
    pid: number,
    readonly remoteResourceId: string,
    readonly capabilities: PtyHostCapabilities = ALL_CAPABILITIES,
  ) {
    super(pid);
  }

  readonly pidDomain = "remote" as const;
  readonly detach = vi.fn();

  onSequencedData = (callback: (event: PtySequencedData) => void) => {
    this.sequenced.add(callback);
    return () => this.sequenced.delete(callback);
  };

  /** Host output: the text, then its sequence (the client's order). */
  emitHost(data: string): number {
    this.sequence += 1;
    this.emitData(data);
    for (const listener of this.sequenced) listener({ sequence: this.sequence, data });
    return this.sequence;
  }

  readonly screen = {
    capabilities: () => this.capabilities,
    snapshot: async (input: PtyScreenSnapshotInput): Promise<PtyScreenSnapshot> => {
      this.snapshotRequests.push(input);
      const through = this.snapshotThrough ?? this.sequence;
      if (this.snapshotGate) await this.snapshotGate;
      return {
        throughSequence: through,
        cols: 100,
        rows: 30,
        scrollbackRows: 0,
        alternateScreen: false,
        fidelity: "full",
        modelState: "live",
        trimmedRows: 0,
        ansi: encoder.encode(this.screenText),
        pendingEscapeTail: new Uint8Array(),
      };
    },
  };

  readonly lifecycle = {
    capabilities: () => this.capabilities,
    evictedPtyId: undefined,
    setViewState: async (state: PtyViewState) => {
      this.viewStates.push(state);
    },
    keepOpen: async () => {
      this.keepOpenCalls += 1;
    },
    onActivity: (callback: (activity: PtyHostActivity) => void) => {
      this.activityListeners.add(callback);
      return () => this.activityListeners.delete(callback);
    },
    onNotice: (callback: (notice: PtyHostLifecycleNotice) => void) => {
      this.noticeListeners.add(callback);
      return () => this.noticeListeners.delete(callback);
    },
  };

  emitActivity(sidebarBusy: boolean): void {
    const activity: PtyHostActivity = {
      idleBusy: sidebarBusy,
      pressureBusy: sidebarBusy,
      sidebarBusy,
      reasons: [],
      lastInputMs: 1_700_000_000_000,
      lastOutputMs: 1_700_000_000_000,
      quietSinceMs: 1_700_000_000_000,
    };
    for (const listener of this.activityListeners) listener(activity);
  }

  emitNotice(kind: string, closesAtMs = 0, noticeId = 1): void {
    for (const listener of this.noticeListeners)
      listener({ noticeId, kind, closesAtMs, occurredAtMs: 1_700_000_000_000 });
  }
}

/** Fake multi-generation controls; every call is recorded. */
export class FakeHostGenerations implements OwnedPtyHostGenerations {
  inventoryEntries: OwnedPtyHostInventoryEntry[] = [];
  notices: OwnedPtyDrainingHostNotice[] = [];
  readonly policies: RemoteAgentHostPolicy[] = [];
  readonly closeAllCalls: Array<{ reason: string; managedOnly: boolean }> = [];
  admitted = "state-1:epoch-1";
  closeAllResult = { closed: 2, unreachable: 0 };
  cold: PtyScreenSnapshot | undefined;
  ready = async () => {};
  admittedKey = async () => this.admitted;
  inventory = async () => [
    {
      status: "ok" as const,
      connectionId: "state-1",
      expectedEpoch: "epoch-1",
      entries: this.inventoryEntries,
    },
  ];
  updatePolicy = async (policy: RemoteAgentHostPolicy) => {
    this.policies.push(policy);
  };
  closeAll = async (input: { reason: "quit" | "update"; managedOnly: boolean }) => {
    this.closeAllCalls.push(input);
    return this.closeAllResult;
  };
  coldSnapshot = async () => {
    if (!this.cold) throw new Error("no cold screen");
    return this.cold;
  };
  drainingNotices = () => this.notices;
  /** Returned by the next replay only (the cursor then moves past them). */
  pendingReplays: OwnedPtyHostGenerationReplay[] = [];
  replayCalls = 0;
  readonly seenNotices: number[] = [];
  recordSeenNotice = (noticeId: number) => {
    this.seenNotices.push(noticeId);
  };
  replayNotices = async () => {
    this.replayCalls += 1;
    const replays = this.pendingReplays;
    this.pendingReplays = [];
    return replays;
  };
  closeDrainingHosts = async () => {
    const closed = this.notices.filter((notice) => notice.canClose).length;
    const remaining = this.notices.length - closed;
    this.notices = this.notices.filter((notice) => !notice.canClose);
    return { closed, remaining };
  };
}

/** A local adapter whose terminals live in a fake terminal host with durable owners. */
export class FakeHostAdapter extends FakePtyAdapter {
  readonly ownership = ownedRuntimeFixture();
  readonly generations = new FakeHostGenerations();
  readonly runtime: OwnedPtyRuntime = {
    ...this.ownership.runtime,
    targetId: "local-terminal-host",
    hostGenerations: this.generations,
  };
  readonly hostProcesses = new Map<string, FakeHostProcess>();
  /** The next fresh spawn is refused at the live limit with this candidate. */
  refuseNext: { candidate?: string; limit?: number; liveCount?: number } | undefined;
  private nextResource = 1;
  private nextHostPid = 30_000;

  readonly ownedRuntimeForTarget = (target: string) =>
    target === "local" ? this.runtime : undefined;

  override spawn(input: PtySpawnInput) {
    return Effect.suspend(() => {
      this.spawnInputs.push(input);
      const ownerKey = `terminal:${input.ownerKey}`;
      if (input.recoverOnly) {
        const retained = this.hostProcesses.get(ownerKey);
        if (!retained || retained.killed)
          return Effect.fail(new PtySpawnError({ adapter: "fake-host", message: "gone" }));
        return Effect.succeed(retained);
      }
      if (this.refuseNext) {
        const refusal = this.refuseNext;
        this.refuseNext = undefined;
        const cause = new RemoteAgentPtyLimitError("limit", {
          ...(refusal.limit ? { limit: refusal.limit } : {}),
          ...(refusal.liveCount ? { liveCount: refusal.liveCount } : {}),
          ...(refusal.candidate ? { evictionCandidatePtyId: refusal.candidate } : {}),
        });
        return Effect.fail(
          new PtySpawnError({ adapter: "local-terminal-host", message: "limit", cause }),
        );
      }
      const resourceId = `pty-${this.nextResource++}`;
      const process = new FakeHostProcess(this.nextHostPid++, resourceId);
      this.processes.push(process);
      this.hostProcesses.set(ownerKey, process);
      this.ownership.rows.set(ownerKey, {
        ...profileOwner(),
        ownerKey,
        target: "local-terminal-host",
        resourceId,
        state: "may-have-been-sent",
      });
      return Effect.succeed(process);
    });
  }
}

export const makeHostManager = Effect.fn("test.makeHostManager")(function* (
  adapter: FakeHostAdapter,
  options: Partial<TerminalManagerOptions> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const logsDir = yield* fs.makeTempDirectoryScoped({ prefix: "bigbud-host-manager-" });
  const views = options.views ?? new TerminalViewRegistry();
  const manager = yield* makeTerminalManagerWithOptions({
    logsDir,
    ptyAdapter: adapter,
    agentDetector: () => Effect.succeed(new Map()),
    subprocessPollIntervalMs: 60_000,
    views,
    ...options,
  });
  return { manager, logsDir, views };
});

export const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
