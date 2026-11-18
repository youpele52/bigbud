/**
 * In-process mock backend for the conformance self-test (WP-5D). It answers the RPCs the
 * harness uses with the same shapes as the real client socket: command receipts keyed by
 * commandId (same payload returns the stored sequence, a different payload is refused),
 * paged `orchestration.replayEvents`, provisioning status, and a 426 for another RPC
 * revision. Turns are played by the mock provider. `faults` break one guarantee each so
 * tests can prove the rows detect it.
 */
import { randomUUID } from "node:crypto";

import type { RpcClient } from "../remoteBackendMeasure.client.ts";
import { CLIENT_RPC_REVISION, type ConformanceBackend } from "./client.ts";
import { runMockTurn } from "./mockProvider.ts";
import type { ReplayedEvent } from "./session.ts";
import type { Workspace } from "./workspace.ts";

export interface MockFaults {
  /** A retried commandId runs the command again instead of returning the receipt. */
  readonly duplicateRunsTwice?: boolean;
  /** Replay returns one of the thread's events twice. */
  readonly replayDuplicatesEvent?: boolean;
  /** A client at another RPC revision is admitted. */
  readonly acceptAnyRevision?: boolean;
  /** The provider keeps running after an interrupt. */
  readonly ignoreInterrupt?: boolean;
}

export interface MockProviderSpec {
  readonly provider: string;
  state: string;
  executableSource: string | null;
  readonly executablePath: string | null;
  readonly message: string | null;
}

/** Self-test providers. Paths and messages carry planted secrets the report must not show. */
export const defaultMockProviders = (): MockProviderSpec[] => [
  {
    provider: "codex",
    state: "ready",
    executableSource: "discovered",
    executablePath: "/home/alice/.nvm/versions/node/v22.11.0/bin/codex",
    message:
      "Signed in; token sk-ant-api03-PLANTEDSECRET0123456789 at /home/alice/.codex/auth.json",
  },
  {
    provider: "claudeAgent",
    state: "needs-auth",
    executableSource: "discovered",
    executablePath: "/home/alice/.local/bin/claude",
    message: "Not signed in (alice@example.com)",
  },
  {
    provider: "copilot",
    state: "missing",
    executableSource: null,
    executablePath: null,
    message: null,
  },
  {
    provider: "muse",
    state: "ready",
    executableSource: "explicit",
    executablePath: "/opt/muse/bin/muse",
    message: null,
  },
  {
    provider: "pi",
    state: "ready",
    executableSource: "bundled",
    executablePath: null,
    message: null,
  },
];

const PAGE_SIZE = 25;

export function makeMockBackend(options: {
  readonly faults?: MockFaults;
  readonly providers?: MockProviderSpec[];
  readonly stepMs?: number;
}) {
  const faults = options.faults ?? {};
  const specs = options.providers ?? defaultMockProviders();
  const events: ReplayedEvent[] = [];
  const receipts = new Map<string, { digest: string; sequence: number; aggregateId: string }>();
  const threads = new Map<string, { provider: string; projectId: string; gone: boolean }>();
  const interrupted = new Set<string>();
  const waiters = new Map<string, (value: unknown) => void>();
  const files = new Map<string, string>();
  const turns: Array<Promise<void>> = [];
  let commandId: string | null = null;

  const append = (aggregateId: string, type: string, payload: Record<string, unknown>) => {
    events.push({
      sequence: events.length + 1,
      eventId: randomUUID(),
      type,
      aggregateId,
      commandId,
      payload,
    });
  };
  const awaitResponse = (requestId: string) =>
    new Promise<unknown>((resolve) => waiters.set(requestId, resolve));
  const respond = (requestId: unknown, value: unknown) => {
    const waiter = waiters.get(String(requestId));
    if (!waiter) throw new Error("RPC orchestration.dispatchCommand failed: unknown request");
    waiters.delete(String(requestId));
    waiter(value);
  };

  function apply(command: Record<string, unknown>): string {
    const threadId = String(command.threadId ?? command.projectId ?? "");
    switch (command.type) {
      case "project.create":
        append(threadId, "project.created", { projectId: command.projectId });
        break;
      case "thread.create": {
        const model = command.modelSelection as { provider: string };
        threads.set(threadId, {
          provider: model.provider,
          projectId: String(command.projectId),
          gone: false,
        });
        append(threadId, "thread.created", { threadId });
        break;
      }
      case "thread.turn.start": {
        const message = command.message as {
          messageId: string;
          text: string;
          attachments: unknown[];
        };
        if (threads.get(threadId)?.provider === "muse" && message.attachments.length > 0)
          throw new Error(
            "RPC orchestration.dispatchCommand failed: Muse Code does not accept attachments",
          );
        append(threadId, "thread.message-sent", {
          threadId,
          ...message,
          role: "user",
          streaming: false,
          turnId: null,
        });
        append(threadId, "thread.turn-start-requested", { threadId, messageId: message.messageId });
        const host = {
          append,
          files,
          awaitResponse,
          stepMs: options.stepMs ?? 2,
          ignoreInterrupt: faults.ignoreInterrupt === true,
          isInterrupted: (id: string) => interrupted.has(id),
        };
        turns.push(
          runMockTurn(host, {
            threadId,
            turnId: `mock-turn-${events.length}`,
            text: message.text,
            attachments: message.attachments,
          }),
        );
        break;
      }
      case "thread.turn.interrupt":
        interrupted.add(threadId);
        append(threadId, "thread.turn-interrupt-requested", { threadId });
        break;
      case "thread.approval.respond":
        append(threadId, "thread.approval-response-requested", { threadId });
        respond(command.requestId, command.decision);
        break;
      case "thread.user-input.respond":
        append(threadId, "thread.user-input-response-requested", { threadId });
        respond(command.requestId, command.answers);
        break;
      case "thread.session.stop":
        interrupted.add(threadId);
        append(threadId, "thread.session-stop-requested", { threadId });
        break;
      case "thread.delete":
      case "thread.archive": {
        const thread = threads.get(threadId);
        if (thread) thread.gone = true;
        append(threadId, command.type === "thread.delete" ? "thread.deleted" : "thread.archived", {
          threadId,
        });
        break;
      }
      case "project.delete":
        append(threadId, "project.deleted", { projectId: command.projectId });
        break;
      default:
        throw new Error(
          `RPC orchestration.dispatchCommand failed: mock has no ${String(command.type)}`,
        );
    }
    return threadId;
  }

  function dispatch(command: Record<string, unknown>) {
    const id = String(command.commandId);
    const digest = JSON.stringify(command);
    const existing = receipts.get(id);
    if (existing && !faults.duplicateRunsTwice) {
      if (existing.digest !== digest)
        throw new Error("RPC orchestration.dispatchCommand failed: command receipt conflict");
      return { sequence: existing.sequence };
    }
    commandId = id;
    try {
      const aggregateId = apply(command);
      receipts.set(id, { digest, sequence: events.length, aggregateId });
      return { sequence: events.length };
    } finally {
      commandId = null;
    }
  }

  function replay(fromExclusive: number) {
    let page = events.filter((event) => event.sequence > fromExclusive).slice(0, PAGE_SIZE);
    const complete = (page.at(-1)?.sequence ?? fromExclusive) >= events.length;
    if (faults.replayDuplicatesEvent && page.length > 1) page = [page[0]!, ...page];
    return { availability: "available", complete, latestSequence: events.length, events: page };
  }

  const handlers: Record<string, (payload: Record<string, unknown>) => unknown> = {
    "orchestration.dispatchCommand": dispatch,
    "orchestration.replayEvents": (payload) => replay(Number(payload.fromSequenceExclusive)),
    "orchestration.getCommandOutcome": (payload) => {
      const receipt = receipts.get(String(payload.commandId));
      return receipt
        ? { commandId: payload.commandId, status: "accepted", resultSequence: receipt.sequence }
        : { commandId: payload.commandId, status: "unknown" };
    },
    "orchestration.getProjectThreadSummaries": (payload) => ({
      threads: [...threads.entries()]
        .filter(([, thread]) => thread.projectId === payload.projectId && !thread.gone)
        .map(([id]) => ({ id })),
    }),
    "server.getConfig": () => ({
      providers: specs.map((spec) => ({
        provider: spec.provider,
        models: [{ slug: "mock-model" }],
      })),
    }),
    "server.getProviderProvisioningStatus": (payload) => ({
      servicePath: "discovered",
      providers: specs
        .filter((spec) => !payload.provider || spec.provider === payload.provider)
        .map((spec) =>
          Object.assign(Object.create(null) as Record<string, unknown>, spec, {
            displayName: spec.provider,
            provisionedBy: "user",
            authStep: "sign in",
            authCheck: `mock#${spec.provider}`,
            manualCommands: [],
            docsUrl: null,
          }),
        ),
    }),
    "server.provisionProvider": (payload) => {
      const spec = specs.find((entry) => entry.provider === payload.provider);
      if (payload.provider !== "copilot" || !spec) throw new Error("mock provisions only copilot");
      spec.state = "ready";
      spec.executableSource = "managed";
      return {
        outcome: "installing",
        entry: spec,
        copilotJob: { id: "mock-job", phase: "downloading" },
      };
    },
    "server.copilotRuntime": () => ({
      available: true,
      job: { id: "mock-job", phase: "installed" },
    }),
  };

  const client = (): RpcClient => ({
    close: () => undefined,
    call: async (tag, payload) => {
      const handler = handlers[tag];
      if (!handler) throw new Error(`RPC ${tag} failed: not in mock`);
      await Promise.resolve();
      return handler((payload ?? {}) as Record<string, unknown>);
    },
  });

  const backend: ConformanceBackend = {
    kind: "mock",
    handshake: async () => ({
      clientRpcRevision: CLIENT_RPC_REVISION,
      backendVersion: "0.0.0-mock",
    }),
    connect: async (revision = CLIENT_RPC_REVISION) => {
      if (revision !== CLIENT_RPC_REVISION && !faults.acceptAnyRevision)
        throw new Error("Unexpected server response: 426");
      return client();
    },
  };
  let removed = false;
  const workspace: Workspace = {
    projectRoot: "/mock/bigbud-conformance-work-self-test/project",
    writeFile: async (relativePath, contents) => void files.set(relativePath, contents),
    remove: async () => void (removed = true),
  };
  return {
    backend,
    workspace,
    inspect: {
      events: () => events,
      liveThreads: () => [...threads.entries()].filter(([, t]) => !t.gone).map(([id]) => id),
      removed: () => removed,
      settleTurns: () => Promise.all(turns),
    },
  };
}
