import { randomBytes } from "node:crypto";
import type { ModelRef, SessionInfo } from "@opencode/client";
import type { OpencodeV2ModelSelection } from "@bigbud/contracts/orchestration/orchestration.provider.ts";
import { v2Request, type OpencodeV2Client } from "./Client.ts";
import { currentV2RequestContext } from "./Client.guard.ts";
import { assertV2ModelAvailable } from "./Runtime.model.availability.ts";
import { logV2SettlementDiagnostic } from "./Runtime.settlement.log.ts";
import { V2TextGenerationUncertain } from "./TextGeneration.errors.ts";
import { makeV2TextGenerationAdmission } from "./TextGeneration.admission.ts";
import type { V2SharedConnection } from "./SharedService.descriptor.ts";

export interface V2TextGenerationConnection {
  readonly client: OpencodeV2Client;
  readonly storageIdentity: string;
  readonly descriptor: V2SharedConnection;
  readonly close: () => Promise<void>;
}
export const V2_TEXT_GENERATION_PERMISSIONS = [
  { action: "*", resource: "*", effect: "deny" as const },
];

/** Never shares an app chat, dispatches an inbox item, executes a tool, or retries a mutation. */
export function makeV2AuxiliaryTextGenerator(input: {
  readonly connect: (signal: AbortSignal) => Promise<V2TextGenerationConnection>;
  readonly maxConcurrent?: number;
  readonly timeoutMs?: number;
}) {
  const issuer = randomBytes(32).toString("base64url");
  const admission = makeV2TextGenerationAdmission(input.maxConcurrent ?? 4);
  return async (request: {
    readonly directory: string;
    readonly prompt: string;
    readonly operation: string;
    readonly selection: OpencodeV2ModelSelection;
    readonly signal: AbortSignal;
  }): Promise<string> => {
    const { selection, signal } = request;
    signal.throwIfAborted();
    if (!selection.subProviderID || !selection.model || selection.model === "default")
      throw new Error("V2 text generation requires an explicit native provider/model.");
    let connection: V2TextGenerationConnection | undefined;
    let mutationUncertain = false;
    let generationDispatched = false;
    let outputVerified = false;
    let native: SessionInfo | undefined;
    const model: ModelRef = {
      providerID: selection.subProviderID,
      id: selection.model,
      ...(selection.options?.variant ? { variant: selection.options.variant } : {}),
    };
    // Full 256-bit issuer + full 256-bit job identity, losslessly encoded within the 100-char router bound.
    const id = `ses_bbtg_${issuer}_${randomBytes(32).toString("base64url")}`;
    const reservation = admission.reserve(id);
    const metadata = {
      bigbud_provider: "opencodeV2",
      bigbud_workload: "text-generation",
      bigbud_issuer: issuer,
      bigbud_operation: request.operation,
    };
    const current = () => {
      signal.throwIfAborted();
      currentV2RequestContext()?.permit.assertCurrent();
    };
    const verify = (session: SessionInfo) => {
      if (
        session.id !== id ||
        session.parentID ||
        session.fork ||
        session.location.directory !== request.directory ||
        session.model?.id !== model.id ||
        session.model.providerID !== model.providerID ||
        (session.model.variant ?? "default") !== (model.variant ?? "default") ||
        JSON.stringify(session.permissions) !== JSON.stringify(V2_TEXT_GENERATION_PERMISSIONS) ||
        Object.entries(metadata).some(([key, value]) => session.metadata?.[key] !== value) ||
        session.metadata?.bigbud_storage !== connection?.storageIdentity
      )
        throw new Error("V2 auxiliary session provenance rejected; history retained.");
    };
    try {
      connection = await input.connect(signal);
      current();
      const client = connection.client;
      await admission.reconcile(connection, signal, id);
      const available = await assertV2ModelAvailable(client, request.directory, model, signal);
      if (
        !available.capabilities.input.includes("text") ||
        !available.capabilities.output.includes("text")
      )
        throw new Error("V2 auxiliary generation requires native text input/output support.");
      current();
      mutationUncertain = true;
      native = await v2Request(
        "auxiliary session.create",
        (abort) =>
          client.session.create(
            {
              id,
              title: "bigbud internal text generation",
              location: { directory: request.directory },
              model,
              metadata: { ...metadata, bigbud_storage: connection!.storageIdentity },
              permissions: V2_TEXT_GENERATION_PERMISSIONS,
            },
            { signal: abort },
          ),
        { signal },
      );
      verify(native);
      current();
      // Read back the created resource, not just the acknowledgement, before paid generation.
      verify(
        await v2Request(
          "auxiliary session.get",
          (abort) => client.session.get({ sessionID: id }, { signal: abort }),
          { signal },
        ),
      );
      current();
      const result = await v2Request(
        "auxiliary session.generate",
        (abort) => {
          generationDispatched = true;
          return client.session.generate(
            { sessionID: id, prompt: request.prompt },
            { signal: abort },
          );
        },
        { signal, timeoutMs: input.timeoutMs ?? 180_000 },
      );
      current();
      verify(
        await v2Request(
          "auxiliary result.verify",
          (abort) => client.session.get({ sessionID: id }, { signal: abort }),
          { signal },
        ),
      );
      current();
      // A fulfilled transient generation is the settlement witness. Never delete on transport ambiguity.
      mutationUncertain = false;
      outputVerified = true;
      return result.text;
    } catch (error) {
      if (generationDispatched && !outputVerified)
        // Native causes can retain private request data. Preserve typed delivery evidence, not the cause.
        throw new V2TextGenerationUncertain({ operation: request.operation, nativeSessionId: id });
      throw error;
    } finally {
      if (connection && native && !mutationUncertain) {
        try {
          current();
          verify(
            await v2Request(
              "auxiliary cleanup.verify",
              (abort) => connection!.client.session.get({ sessionID: id }, { signal: abort }),
              { signal },
            ),
          );
          mutationUncertain = true;
          await v2Request(
            "auxiliary session.remove",
            (abort) => connection!.client.session.remove({ sessionID: id }, { signal: abort }),
            { signal },
          );
          mutationUncertain = false;
        } catch {
          // No foreign/uncertain deletion, replay or daemon shutdown. Keep a bounded capacity hold.
          mutationUncertain = true;
        }
      }
      // Borrowed client disposal cannot discard already verified output or authorize paid fallback.
      await connection?.close().catch(() => {
        logV2SettlementDiagnostic("V2 auxiliary client disposal unavailable", {
          operation: request.operation,
        });
      });
      if (!mutationUncertain) reservation.release(outputVerified);
      else
        logV2SettlementDiagnostic("V2 auxiliary text-generation history/capacity retained", {
          operation: request.operation,
          occupied: admission.occupied(),
        });
    }
  };
}
