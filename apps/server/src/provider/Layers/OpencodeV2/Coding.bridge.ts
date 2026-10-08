import { createHash } from "node:crypto";
import path from "node:path";
import { Schema, Effect } from "effect";
import { RuntimeRequestId } from "@bigbud/contracts/core/baseSchemas";
import type { ProviderApprovalDecision, ProviderRuntimeEvent } from "@bigbud/contracts";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { type V2CodingFileAction, type V2CodingTarget } from "./Coding.files.ts";
import { openV2OwnedFiles } from "./Coding.files.owner.ts";
import { v2CanonicalActionIsAutomatic } from "./Coding.approval.ts";
import { V2CodingReceipts } from "./Coding.receipts.ts";
import { runtimeEventBase } from "./Runtime.projection.ts";
import { v2ReplyGuard } from "./Runtime.replies.ts";
import { prepareV2ExecutionAction } from "./Execution.actions.ts";
import { ApprovalExecutionIntent } from "@bigbud/contracts/orchestration/approvalIntent.ts";
import { V2ActiveExecutions } from "./Execution.owners.ts";

const Invocation = Schema.Struct({
  action: Schema.Literals([
    "read",
    "list",
    "write",
    "edit",
    "skill",
    "check",
    "shell",
    "orchestration",
  ]),
  sessionID: Schema.String,
  messageID: Schema.String,
  callID: Schema.String,
  input: Schema.Struct({
    path: Schema.String,
    content: Schema.optional(Schema.String),
    oldText: Schema.optional(Schema.String),
    newText: Schema.optional(Schema.String),
    command: Schema.optional(Schema.String),
    request: Schema.optional(Schema.Unknown),
  }),
});
interface Pending {
  readonly event: ProviderRuntimeEvent;
  readonly settle: (approved: boolean) => void;
  readonly fingerprint: string;
}
interface Owner {
  readonly session: V2RuntimeSession;
  readonly runtime: OpencodeV2Runtime;
  readonly files: V2CodingTarget;
  readonly pending: Map<string, Pending>;
  revoked: boolean;
  readonly active: V2ActiveExecutions;
  cancelledTurn?: string | undefined;
}

/** Trusted plugin transport invokes only this exact canonical owner; approvals never grant native filesystem tools. */
export class V2CodingBridge {
  private readonly owners = new Map<string, Owner>();
  private constructor(
    private readonly python: string | undefined,
    private readonly receipts: V2CodingReceipts,
  ) {}
  get supportsLocalFiles() {
    return Boolean(this.python);
  }
  static async open(profile: string, python?: string) {
    return new V2CodingBridge(python, await V2CodingReceipts.open(profile));
  }
  async attach(session: V2RuntimeSession, runtime: OpencodeV2Runtime) {
    if (!session.localTools) return;
    const files = await openV2OwnedFiles(session, runtime.options.config.profileRoot, this.python);
    const owner: Owner = {
      session,
      runtime,
      files,
      pending: new Map(),
      revoked: false,
      active: new V2ActiveExecutions(),
    };
    this.owners.set(session.native.id, owner);
    session.coding = {
      pending: () => [...owner.pending.values()].map((p) => p.event),
      cancelActive: () => {
        owner.cancelledTurn = owner.session.row?.turnId;
        return owner.active.cancel();
      },
      revoke: () => {
        owner.revoked = true;
        if (this.owners.get(session.native.id) === owner) this.owners.delete(session.native.id);
        for (const request of owner.pending.values()) request.settle(false);
        void owner.active.cancel();
      },
    };
  }
  private async guard(owner: Owner) {
    if (owner.revoked) throw new Error("V2 coding owner revoked.");
    await Effect.runPromise(
      owner.runtime.options.journal.assertOwnerAvailable(owner.session.threadId),
    );
    const validate = await v2ReplyGuard(
      owner.runtime.options,
      owner.runtime.sessions,
      owner.session,
    )();
    validate();
    if (owner.revoked || !owner.session.row || owner.session.row.state === "terminal")
      throw new Error("V2 coding admission is not live.");
    return () => {
      validate();
      if (owner.revoked) throw new Error("V2 coding owner revoked.");
    };
  }
  async invoke(value: unknown, signal?: AbortSignal) {
    const controller = new AbortController();
    signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const assertActive = () => {
      if (signal?.aborted) throw new Error("V2 coding invocation cancelled.");
    };
    assertActive();
    const request = Schema.decodeUnknownSync(Invocation)(value);
    const owner = this.owners.get(request.sessionID);
    if (!owner) throw new Error("V2 coding session is not owned.");
    return owner.active.run(controller, async () => {
      await this.guard(owner);
      const row = owner.session.row!;
      const key = JSON.stringify([
        row.binding.storageIdentity,
        row.turnId,
        request.messageID,
        request.callID,
      ]);
      const invocationFingerprint = createHash("sha256")
        .update(JSON.stringify({ action: request.action, input: request.input }))
        .digest("hex");
      const replay = await this.receipts.find(key, invocationFingerprint);
      if (replay) return replay;
      if (owner.cancelledTurn === row.turnId)
        throw new Error("V2 coding turn was interrupted; no new execution for this admission.");
      const id = `bbv2-code:${createHash("sha256").update(key).digest("hex")}`;
      const input = request.input;
      const relative =
        request.action === "skill" ? `.agents/skills/${input.path}/SKILL.md` : input.path;
      if (
        relative.length > 4096 ||
        path.isAbsolute(relative) ||
        relative.split("/").some((p) => p === ".." || !p) ||
        relative.includes("\\")
      )
        throw new Error("V2 coding requires canonical relative paths.");
      const execution =
        request.action === "shell" || request.action === "orchestration"
          ? prepareV2ExecutionAction(
              owner.session,
              owner.runtime.options.config.profileRoot,
              request.action,
              input,
              [
                row.binding.storageIdentity,
                row.turnId,
                request.sessionID,
                request.messageID,
                request.callID,
              ],
              signal,
            )
          : undefined;
      if (execution && relative !== ".")
        throw new Error(
          "V2 execution targets the exact bound workspace root, not an alternate path.",
        );
      let action: V2CodingFileAction = {
        action:
          request.action === "shell" || request.action === "orchestration"
            ? "probe"
            : request.action,
        path: relative,
      };
      if (!execution && request.action !== "write" && request.action !== "edit")
        await owner.files.run({
          action: request.action === "list" ? "list" : "probe",
          path: relative,
        });
      if (request.action === "write" || request.action === "edit") {
        let current;
        try {
          current = await owner.files.run({ action: "read", path: relative });
        } catch (error) {
          if (
            request.action !== "write" ||
            !(error instanceof Error && error.message.includes("No such file"))
          )
            throw error;
        }
        let content = input.content;
        if (request.action === "edit") {
          const newText = input.newText;
          if (
            !input.oldText ||
            newText === undefined ||
            current?.content === undefined ||
            current.content.split(input.oldText).length !== 2
          )
            throw new Error("V2 edit requires exactly one oldText match.");
          content = current.content.replace(input.oldText, () => newText);
        }
        if (content === undefined || Buffer.byteLength(content) > 131072)
          throw new Error("V2 coding text exceeds bound or is missing.");
        action = { ...action, content, expectedSha256: current?.sha256 ?? null };
      }
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(execution?.intent ?? action))
        .digest("hex");
      const executionIntent = execution
        ? Schema.decodeUnknownSync(ApprovalExecutionIntent)({
            format: "json",
            content: JSON.stringify(execution.intent, null, 2),
          })
        : undefined;
      if (owner.pending.has(id) || owner.pending.size >= 16)
        throw new Error("V2 coding duplicate or pending-action bound.");
      let settle!: (approved: boolean) => void;
      const approval = new Promise<boolean>((resolve) => {
        settle = resolve;
      });
      const cancel = () => settle(false);
      signal?.addEventListener("abort", cancel, { once: true });
      const targetPath = owner.files.executionTargetId
        ? path.posix.join(owner.files.root, relative)
        : path.join(owner.files.root, relative);
      const event: ProviderRuntimeEvent = {
        ...runtimeEventBase(owner.session, id),
        requestId: RuntimeRequestId.makeUnsafe(id),
        type: "request.opened",
        payload: {
          requestType: execution
            ? "command_execution_approval"
            : action.action === "write" || action.action === "edit"
              ? "file_change_approval"
              : "file_read_approval",
          detail: `bigbud ${owner.session.session.runtimeMode} ${request.action}: ${targetPath}${owner.files.executionTargetId ? ` (${owner.files.executionTargetId})` : ""}`,
          args: {
            action: action.action,
            path: targetPath,
            ...(owner.files.executionTargetId
              ? { executionTargetId: owner.files.executionTargetId }
              : {}),
            expectedSha256: action.expectedSha256,
            proposedContent: action.content,
            ...(execution ? { executionIntent: execution.intent } : {}),
            fingerprint,
          },
          sessionApprovalAvailable: false,
          ...(executionIntent ? { executionIntent } : {}),
        },
      };
      const canonicalMode =
        owner.session.executionPolicy?.canonicalMode ?? owner.session.session.runtimeMode;
      const automatic =
        canonicalMode !== "disabled" && v2CanonicalActionIsAutomatic(canonicalMode, request.action);
      if (automatic) settle(true);
      else {
        owner.pending.set(id, { event, settle, fingerprint });
        owner.session.pendingInteractions ??= new Map();
        owner.session.pendingInteractions.set(`request.opened:${id}`, event);
      }
      try {
        assertActive();
        if (!automatic) await owner.runtime.emit(owner.session, event);
        if (!(await approval)) throw new Error("V2 coding action denied or revoked.");
        return await owner.active.dispatch(controller, () =>
          owner.runtime.withSession(owner.session.threadId, async () => {
            const validate = await this.guard(owner);
            owner.runtime.mutations.assertSafe();
            validate();
            assertActive();
            if (
              owner.session.row?.turnId !== row.turnId ||
              owner.session.row.nativeAdmissionId !== row.nativeAdmissionId
            )
              throw new Error("V2 coding turn owner changed.");
            return this.receipts.run(key, invocationFingerprint, () => {
              const guard = async () => {
                const validateAction = await owner.runtime.mutations.withNamespace(() =>
                  this.guard(owner),
                );
                return () => {
                  owner.runtime.mutations.assertSafe();
                  validateAction();
                  assertActive();
                };
              };
              return execution ? execution.run(guard) : owner.files.run(action, guard);
            });
          }),
        );
      } finally {
        signal?.removeEventListener("abort", cancel);
        owner.pending.delete(id);
      }
    });
  }
  async reply(
    runtime: OpencodeV2Runtime,
    session: V2RuntimeSession,
    id: string,
    decision: ProviderApprovalDecision,
  ) {
    const owner = this.owners.get(session.native.id);
    const pending = owner?.pending.get(id);
    if (!owner || owner.runtime !== runtime || !pending)
      throw new Error("V2 coding request no longer owned.");
    if (decision === "acceptForSession")
      throw new Error("V2 coding requires once-only explicit approval.");
    const validate = await this.guard(owner);
    validate();
    if (pending.event.type !== "request.opened") throw new Error("V2 coding request type invalid.");
    await runtime.emit(session, {
      ...runtimeEventBase(session, `${id}:resolved`),
      requestId: RuntimeRequestId.makeUnsafe(id),
      type: "request.resolved",
      payload: { requestType: pending.event.payload.requestType, decision },
    });
    session.pendingInteractions?.delete(`request.opened:${id}`);
    owner.pending.delete(id);
    pending.settle(decision === "accept");
  }
  close() {
    for (const owner of this.owners.values()) owner.session.coding?.revoke();
  }
}
