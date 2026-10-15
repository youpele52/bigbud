import { createHash } from "node:crypto";
import type { Owner } from "./Orchestration.bridge.ts";
import type { V2ThreadInvocation } from "./Orchestration.callback.ts";
import { guardV2ThreadInvocation } from "./Orchestration.admission.ts";
import {
  callV2PreparedOrchestration,
  prepareV2OrchestrationRequest,
} from "./Execution.orchestration.ts";
import type { V2ThreadImplementationRegistry } from "./Orchestration.implementation.ts";
import type { V2ThreadReceipts } from "./Orchestration.receipts.ts";
import type { V2PureJson } from "./Orchestration.implementation.types.ts";
import {
  v2ImmutableJson,
  v2CanonicalThreadAction,
  validateV2PreparedBody,
  encodeV2FinalResult,
} from "./Orchestration.implementation.boundary.ts";

/** Capture one immutable handler before awaits; durable replay is inspected before either pure method executes. */
export async function invokeV2ThreadOwner(
  owner: Owner,
  request: V2ThreadInvocation,
  signal: AbortSignal,
  implementations: V2ThreadImplementationRegistry,
  receipts: V2ThreadReceipts,
) {
  const { session, runtime, enrollment } = owner,
    controller = new AbortController();
  const captured = implementations.acquire(owner.implementation);
  signal = AbortSignal.any([signal, controller.signal]);
  return owner.active
    .run(controller, async () => {
      const guard = () =>
        guardV2ThreadInvocation(
          runtime,
          session,
          request,
          () => {
            owner.nativeProof?.assertCurrent();
            enrollment.assertLive();
          },
          signal,
        );
      const initial = await guard();
      initial();
      await session.resources?.renewCanonicalAuth?.();
      initial();
      const row = session.row!;
      if (owner.cancelledTurn === row.turnId) throw new Error("V2 canonical turn interrupted.");
      const identity = [
          row.binding.storageIdentity,
          row.turnId,
          session.native.id,
          request.messageID,
          request.callID,
        ],
        key = JSON.stringify(identity);
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([v2CanonicalThreadAction(request.action), request.input]))
        .digest("hex");
      return receipts
        .once(key, fingerprint, async () => {
          const replay = await receipts.find(key, fingerprint);
          if (replay) return replay;
          const body = validateV2PreparedBody(
            request.action,
            captured.handler.prepare({
              action: request.action,
              input: v2ImmutableJson(request.input) as Readonly<Record<string, V2PureJson>>,
              callerThreadId: session.threadId,
            }),
            session.threadId,
          );
          const prepared = prepareV2OrchestrationRequest(body, identity),
            { action: _action, ...argumentsForApproval } = body;
          await owner.approvals.require(
            key,
            {
              action: body.action,
              arguments: argumentsForApproval,
              invocationId: prepared.invocationId,
            },
            initial,
            signal,
          );
          const validate = await guard();
          validate();
          runtime.mutations.assertSafe();
          if (session.row !== row || owner.cancelledTurn === row.turnId)
            throw new Error("V2 canonical admission replaced/interrupted.");
          return owner.active.dispatch(
            controller,
            () =>
              receipts.run(
                key,
                fingerprint,
                async () => {
                  const canonical = await callV2PreparedOrchestration(
                    session.resources!.orchestration!,
                    prepared,
                    guard,
                    signal,
                  );
                  return encodeV2FinalResult(
                    captured.handler.interpret({
                      action: request.action,
                      canonicalResult: v2ImmutableJson(JSON.parse(canonical.content)),
                    }),
                  );
                },
                {
                  implementationDigest: captured.handler.implementationDigest,
                  requestDigest: createHash("sha256")
                    .update(JSON.stringify(prepared))
                    .digest("hex"),
                  resultEncoding: captured.handler.resultEncoding,
                },
              ),
            key, // Durable receipt identity for H1 settlement reconciliation.
          );
        })
        .then((result) => JSON.parse(result.content));
    })
    .finally(captured.release);
}
