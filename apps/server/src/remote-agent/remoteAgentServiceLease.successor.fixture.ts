/** Scripted native successor replies; protocol-only, never a native or socket proof. */
import { MOBILE_GATEWAY_CREDENTIAL_ENV } from "@bigbud/shared/mobileGatewaySupervisor.config";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import type { RemoteAgentServiceLeaseResponse as Response } from "./remoteAgentProtocol.serviceLease.ts";
import { launch, response } from "./remoteAgentServiceLease.test.fixture.ts";

/** Matches the synthetic /proc controller identity mocked by each successor test file. */
export const successorController = { pid: process.pid, boot: "fixture-boot", started: "123" };
export const priorController = { pid: 4242, boot: "fixture-boot", started: "77" };
export const successorCredential = "s".repeat(64);
type Kind = "start" | "status" | "resume" | "control";
export type SuccessorReply = Partial<Response> | "lost";

/** The default grant is a successor takeover at generation 2 with the original bootstrap. */
export function successorFixture(
  script: Partial<Record<Kind, SuccessorReply[]>> = {},
  options: { readonly epoch?: string } = {},
) {
  const input = launch();
  const queues = new Map(Object.entries(script) as Array<[Kind, SuccessorReply[]]>);
  const sent: Array<{ kind: Kind; action?: string }> = [];
  const waiters: Array<{
    matches?: (frame: RemoteAgentFrame) => boolean;
    resolve: (frame: RemoteAgentFrame) => void;
    reject: (error: Error) => void;
  }> = [];
  const base: Response = {
    ...response(input, 2),
    state: "attaching",
    bootstrap: [{ name: MOBILE_GATEWAY_CREDENTIAL_ENV, value: successorCredential }],
    originalController: priorController,
    currentController: successorController,
    previousController: priorController,
  };
  const raw = {
    handshake: async () => ({
      agentEpoch: options.epoch ?? "epoch",
      protocolMinor: 8,
      capabilities: [{ name: "service.lease", major: 1, minor: 2 }],
    }),
    supportsCapability: () => true,
    nextFrame: (matches?: (frame: RemoteAgentFrame) => boolean) =>
      new Promise<RemoteAgentFrame>((resolve, reject) =>
        waiters.push({ ...(matches ? { matches } : {}), resolve, reject }),
      ),
    send: async (frame: RemoteAgentFrame) => {
      if (!frame.type.startsWith("serviceLease") || !("capability" in frame.value))
        throw Error("Unexpected fixture request.");
      const kind = frame.type.replace(/^serviceLease|Request$/g, "").toLowerCase() as Kind;
      const action = "action" in frame.value ? frame.value.action : undefined;
      sent.push({ kind, ...(action ? { action } : {}) });
      const next = queues.get(kind)?.shift() ?? {};
      if (next === "lost") return;
      // Echo the requested original binding, as native does, so fresh attempts correlate too.
      const binding = frame.value.binding ?? base.binding;
      const answer: Response = { ...base, binding, ...next, requestId: frame.value.requestId };
      const type = `serviceLease${kind[0]!.toUpperCase()}${kind.slice(1)}Response` as const;
      const reply = { type, value: answer } as RemoteAgentFrame;
      queueMicrotask(() => {
        const index = waiters.findIndex((waiter) => !waiter.matches || waiter.matches(reply));
        if (index >= 0) waiters.splice(index, 1)[0]?.resolve(reply);
      });
    },
    closeConfirmed: async () => {
      for (const waiter of waiters.splice(0)) waiter.reject(Error("Fixture proxy closed."));
    },
  };
  return {
    input,
    connection: raw as unknown as RemoteAgentConnection,
    sent: () => sent.map((value) => value.action ?? value.kind),
  };
}
/** Native confirmed exit of the original scope, as stop-original/terminal status replies. */
export const exitedReply: SuccessorReply = {
  state: "exited",
  generation: 0,
  bootstrap: [],
};
export const refusedReply: SuccessorReply = {
  accepted: false,
  state: "refused",
  errorCode: "LEASE_REFUSED",
  binding: undefined,
  generation: 0,
  originalChildPid: 0,
  bootstrap: [],
  originalController: undefined,
  currentController: undefined,
  previousController: undefined,
};
