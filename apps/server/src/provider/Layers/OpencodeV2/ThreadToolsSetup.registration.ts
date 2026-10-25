import type { V2PluginSetupArtifact } from "./PluginSetup.record.ts";
import type { OpencodeV2SharedBinding } from "../../../persistence/Services/OpencodeV2SharedBindings.ts";
import type { ProviderTurnAdmission } from "@bigbud/contracts/orchestration/providerTurnAdmission.ts";
import { decodeV2Cursor } from "./Runtime.cursor.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import { selectV2SessionArtifact } from "./Orchestration.selection.ts";
import { v2RetainedRegistrationFamily } from "./Runtime.registration.ts";

/** Setup follows the same durable per-session identity as execution, never a loaded foreign plugin. */
export async function selectV2SetupArtifact(
  preferred: V2PluginSetupArtifact,
  input: {
    threadId: string;
    directory: string;
    binding?: OpencodeV2SharedBinding | undefined;
    admission?: ProviderTurnAdmission | undefined;
    cursor?: unknown;
  },
) {
  const cursor = input.cursor == null ? undefined : decodeV2Cursor(input.cursor);
  const candidates = [
    input.binding,
    input.admission
      ? { ...input.admission.binding, directory: input.admission.binding.location }
      : undefined,
    cursor,
  ].filter((value) => value !== undefined);
  const first = candidates[0];
  if (!first) return preferred;
  if (
    candidates.some(
      (value) =>
        value.nativeSessionId !== first.nativeSessionId ||
        value.storageIdentity !== first.storageIdentity ||
        value.directory !== input.directory,
    )
  )
    throw new Error("V2 retained setup identity conflicts; no replacement or replay.");
  const registrationFamily = v2RetainedRegistrationFamily(input.binding, cursor, preferred.issuer);
  const records = await V2ThreadRecords.open(
    preferred.root,
    "enrollments",
    preferred.privateKey,
    preferred.publicKey,
  );
  return selectV2SessionArtifact(preferred, records, {
    threadId: input.threadId,
    directory: input.directory,
    nativeSessionId: first.nativeSessionId,
    storageIdentity: first.storageIdentity,
    registrationFamily,
  });
}
