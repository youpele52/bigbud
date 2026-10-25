import { createHash } from "node:crypto";
import { RuntimeRequestId } from "@bigbud/contracts/core/baseSchemas";
import type { ProviderApprovalDecision, ProviderRuntimeEvent } from "@bigbud/contracts";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { runtimeEventBase } from "./Runtime.projection.ts";
import { v2CanonicalActionIsAutomatic } from "./Coding.approval.ts";

interface Pending {
  readonly event: Extract<ProviderRuntimeEvent, { type: "request.opened" }>;
  readonly settle: (allowed: boolean) => void;
  readonly assertCurrent: () => void;
}

/** Native asks are independent: executing a native tool is not proof of canonical once-approval. */
export class V2ThreadApprovals {
  private readonly pending = new Map<string, Pending>();
  constructor(
    private readonly runtime: OpencodeV2Runtime,
    private readonly session: V2RuntimeSession,
  ) {}
  events() {
    return [...this.pending.values()].map((item) => item.event);
  }
  cancel() {
    for (const item of this.pending.values()) item.settle(false);
  }

  async require(key: string, intent: unknown, assertCurrent: () => void, signal: AbortSignal) {
    assertCurrent();
    signal.throwIfAborted();
    const mode = this.session.executionPolicy?.canonicalMode ?? this.session.session.runtimeMode;
    if (mode !== "disabled" && v2CanonicalActionIsAutomatic(mode, "orchestration")) return;
    if (this.pending.size >= 16) throw new Error("V2 canonical pending approval capacity reached.");
    const id = `bbv2-thread:${createHash("sha256").update(key).digest("hex")}`;
    if (this.pending.has(id)) throw new Error("V2 canonical approval already pending.");
    let settle!: (allowed: boolean) => void;
    const approval = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const event: Extract<ProviderRuntimeEvent, { type: "request.opened" }> = {
      ...runtimeEventBase(this.session, id),
      requestId: RuntimeRequestId.makeUnsafe(id),
      type: "request.opened",
      payload: {
        requestType: "command_execution_approval",
        detail: `bigbud ${mode} canonical thread action`,
        args: { executionIntent: intent },
        sessionApprovalAvailable: false,
        executionIntent: { format: "json", content: JSON.stringify(intent, null, 2) },
      },
    };
    const cancel = () => settle(false);
    signal.addEventListener("abort", cancel, { once: true });
    this.pending.set(id, { event, settle, assertCurrent });
    this.session.pendingInteractions ??= new Map();
    this.session.pendingInteractions.set(`request.opened:${id}`, event);
    try {
      await this.runtime.emit(this.session, event, assertCurrent);
      if (!(await approval)) throw new Error("V2 canonical action denied/revoked.");
      assertCurrent();
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener("abort", cancel);
      this.pending.delete(id);
      this.session.pendingInteractions.delete(`request.opened:${id}`);
    }
  }

  async reply(id: string, decision: ProviderApprovalDecision) {
    if (decision === "acceptForSession")
      throw new Error("V2 canonical actions require once-only approval.");
    const item = this.pending.get(id);
    if (!item) throw new Error("V2 canonical approval owner unavailable.");
    item.assertCurrent();
    await this.runtime.emit(
      this.session,
      {
        ...runtimeEventBase(this.session, `${id}:resolved`),
        requestId: RuntimeRequestId.makeUnsafe(id),
        type: "request.resolved",
        payload: { requestType: item.event.payload.requestType, decision },
      },
      item.assertCurrent,
    );
    item.assertCurrent();
    item.settle(decision === "accept");
  }
}
