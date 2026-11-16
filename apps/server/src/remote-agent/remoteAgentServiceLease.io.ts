import { randomUUID } from "node:crypto";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type {
  RemoteAgentServiceLeaseFrame,
  RemoteAgentServiceLeaseResponse,
} from "./remoteAgentProtocol.serviceLease.ts";

/** Dedicated original proxy only. Response loss retires observation, never native work. */
type RequestFrame = Extract<
  RemoteAgentServiceLeaseFrame,
  {
    type:
      | "serviceLeaseStartRequest"
      | "serviceLeaseStatusRequest"
      | "serviceLeaseResumeRequest"
      | "serviceLeaseControlRequest";
  }
>;
export class NativeLeaseIo {
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly cancellation = new AbortController();
  private disposal: Promise<void> | undefined;
  constructor(private readonly connection: RemoteAgentConnection) {}
  assertOpen() {
    if (this.closed) throw Error("Native lease owner client is disposed.");
  }
  async request(
    make: (id: string) => RequestFrame,
    signal?: AbortSignal,
  ): Promise<RemoteAgentServiceLeaseResponse> {
    this.assertOpen();
    signal?.throwIfAborted();
    if (this.pending.size >= 16) throw Error("Native lease owner request capacity is exhausted.");
    const id = randomUUID(),
      frame = make(id);
    const expected = {
      serviceLeaseStartRequest: "serviceLeaseStartResponse",
      serviceLeaseStatusRequest: "serviceLeaseStatusResponse",
      serviceLeaseResumeRequest: "serviceLeaseResumeResponse",
      serviceLeaseControlRequest: "serviceLeaseControlResponse",
    }[frame.type];
    if (!expected) throw Error("Invalid native lease request.");
    const response = this.connection.nextFrame(
      (value) =>
        value.type === expected && "requestId" in value.value && value.value.requestId === id,
    );
    const operation = Promise.all([this.connection.send(frame), response]).then(([, reply]) => {
      if (
        reply.type !== expected ||
        (reply.type !== "serviceLeaseStartResponse" &&
          reply.type !== "serviceLeaseStatusResponse" &&
          reply.type !== "serviceLeaseResumeResponse" &&
          reply.type !== "serviceLeaseControlResponse")
      )
        throw Error("Invalid native lease reply.");
      return reply.value;
    });
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => {});
    const combined = AbortSignal.any([
      this.cancellation.signal,
      AbortSignal.timeout(20_000),
      ...(signal ? [signal] : []),
    ]);
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          abort = () =>
            reject(
              Error("Native lease observation ended; original acceptance remains unresolved."),
            );
          if (combined.aborted) abort();
          else combined.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } finally {
      if (abort) combined.removeEventListener("abort", abort);
    }
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true;
    this.cancellation.abort();
    this.disposal = (async () => {
      // This confirms the original proxy only, never the independent native child.
      await this.connection.closeConfirmed();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(this.pending),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () =>
                reject(Error("Native lease proxy IO did not settle; preserve original intent.")),
              1000,
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    })();
    return this.disposal;
  }
}
