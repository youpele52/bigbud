import { constants } from "node:os";
import { finished } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

import {
  REMOTE_AGENT_PROXY_CLOSE_TIMEOUT_MS,
  type RemoteAgentProxyLease,
  type RemoteAgentProxyPipes,
} from "../remote-agent/remoteAgentConnection.owner.ts";
import {
  validateProofAgentCloseTimeout,
  type PickerProofAgentFixture,
  type ProofAgentProxyOperation,
  type ProofAgentProxyStatus,
} from "./sshOwnerPickerProof.codec.agentProxy.ts";
import { invalid, PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

const STATUS_INTERVAL_MS = 1_000;

export interface PickerProofAgentProxyInput extends PickerProofAgentFixture {
  readonly executionTargetId: string;
}

interface AgentChannels {
  readonly pipes: RemoteAgentProxyPipes;
  readonly dispose: () => void;
}

type Execute = (
  operation: ProofAgentProxyOperation,
  beforeDispatch?: () => void,
) => Promise<ProofAgentProxyStatus | undefined>;

export async function waitForProofAgentAdmission(active: Promise<unknown>, timeoutMs: number) {
  const timer = new AbortController();
  try {
    await Promise.race([
      active.catch(() => undefined),
      delay(timeoutMs, undefined, { signal: timer.signal }).then(() => {
        throw new PickerProofOwnerError("operationDenied");
      }),
    ]);
  } finally {
    timer.abort();
  }
}

export function makeProofAgentProxyClient(
  targetId: string,
  fixture: PickerProofAgentFixture | undefined,
  takeChannels: () => AgentChannels,
  execute: Execute,
) {
  return makeProofDuplexClient<PickerProofAgentProxyInput>(
    targetId,
    (input) =>
      fixture && input.binaryPath === fixture.binaryPath && input.sha256 === fixture.sha256
        ? { kind: "openProofAgentProxy", ...fixture }
        : undefined,
    takeChannels,
    execute,
  );
}

type ProofDuplexOpen = Extract<
  ProofAgentProxyOperation,
  {
    kind:
      | "openProofAgentProxy"
      | "openProofClientRelay"
      | "openProofCodex"
      | "openProofPi"
      | "openProofPeerRelay"
      | "openProofGitUpload"
      | "openProofGitAdvertisement";
  }
>;

export function makeProofDuplexClient<Input extends { readonly executionTargetId: string }>(
  targetId: string,
  select: (input: Input) => ProofDuplexOpen | undefined,
  takeChannels: () => AgentChannels,
  execute: Execute,
) {
  let consumed = false;
  return async function open(input: Input, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (input.executionTargetId !== targetId) throw new PickerProofOwnerError("invalidOperands");
    const operation = select(input);
    if (!operation || consumed) throw new PickerProofOwnerError("operationDenied");
    let channels: AgentChannels | undefined;
    try {
      const opened = await execute(operation, () => {
        signal?.throwIfAborted();
        channels = takeChannels();
        // Dispatch can consume the inherited descriptors even if its reply is lost.
        consumed = true;
      });
      if (!opened || !channels) return invalid();
      const lease = makeLease(
        channels.pipes,
        opened,
        execute,
        operation.kind === "openProofClientRelay" || operation.kind === "openProofPeerRelay",
      );
      if (signal?.aborted) {
        try {
          await lease.close({ mode: "terminate", timeoutMs: REMOTE_AGENT_PROXY_CLOSE_TIMEOUT_MS });
        } catch (cleanup) {
          throw unconfirmedAcquisitionCleanup(signal.reason, cleanup);
        }
        signal.throwIfAborted();
      }
      return lease;
    } catch (error) {
      channels?.dispose();
      throw error;
    }
  };
}

function unconfirmedAcquisitionCleanup(abort: unknown, cleanup: unknown) {
  return new AggregateError(
    [abort, cleanup],
    "Proof agent acquisition cleanup was not confirmed.",
    {
      cause: abort,
    },
  );
}

export type PickerProofDuplexLease = RemoteAgentProxyLease & {
  readonly reap: RemoteAgentProxyLease["exit"];
};

function makeLease(
  pipes: RemoteAgentProxyPipes,
  opened: ProofAgentProxyStatus,
  execute: Execute,
  retainReapAfterPipeFailure: boolean,
): PickerProofDuplexLease {
  const { lease, pid } = opened;
  const status = Promise.withResolvers<ProofAgentProxyStatus>();
  const polling = new AbortController();
  let confirmed = false;
  let closing = false;
  let closeAttempt: Promise<void> | undefined;
  const confirm = (result: ProofAgentProxyStatus) => {
    confirmed = true;
    polling.abort();
    pipes.stdin.destroy();
    status.resolve(result);
  };
  const poll = async () => {
    while (!polling.signal.aborted) {
      if (!closing) {
        const result = await execute({ kind: "proofAgentProxyStatus", lease, pid });
        if (result?.closed) {
          confirm(result);
          return;
        }
      }
      await delay(STATUS_INTERVAL_MS, undefined, { signal: polling.signal, ref: false });
    }
  };
  const drained = Promise.all([
    finished(pipes.stdout, { readable: true, writable: false, cleanup: true }),
    finished(pipes.stderr, { readable: true, writable: false, cleanup: true }),
  ]);
  const reap = status.promise.then(proofExit).finally(() => polling.abort());
  const exit = Promise.all([reap, drained]).then(([result]) => result);
  // A transport failure before the caller attaches its exit observer is still
  // observable on `exit`; it must not become an unhandled rejection.
  void exit.catch(() => {});
  if (opened.closed) confirm(opened);
  else
    // The native owner drops its copies of the raw descriptors on launch. Do
    // not spend grants polling a live stream; check after the caller drains it.
    void drained
      .then(poll, (error: unknown) => (retainReapAfterPipeFailure ? poll() : Promise.reject(error)))
      .catch((error: unknown) => {
        if (!polling.signal.aborted) status.reject(error);
      });

  return {
    pipes,
    exit,
    reap,
    async close({ mode, timeoutMs }) {
      validateProofAgentCloseTimeout(timeoutMs);
      if (mode !== "graceful" && mode !== "terminate")
        throw new PickerProofOwnerError("invalidOperands");
      if (confirmed) return;
      // First close wins. Do not send a second close after an ambiguous reply.
      closeAttempt ??= (async () => {
        closing = true;
        try {
          const result = await execute(
            {
              kind: "closeProofAgentProxy",
              lease,
              pid,
              terminate: mode === "terminate",
              timeoutMs,
            },
            () => {
              if (mode === "graceful") pipes.stdin.end();
            },
          );
          if (!result?.closed) throw new PickerProofOwnerError("outcomeUnknown");
          confirm(result);
        } finally {
          closing = false;
        }
      })();
      return closeAttempt;
    },
  };
}

function proofExit({ code, signal }: ProofAgentProxyStatus) {
  if (code !== undefined) return { code, signal: null };
  const name = Object.entries(constants.signals).find(([, number]) => number === signal)?.[0];
  if (name) return { code: null, signal: name };
  throw new PickerProofOwnerError("outcomeUnknown");
}
