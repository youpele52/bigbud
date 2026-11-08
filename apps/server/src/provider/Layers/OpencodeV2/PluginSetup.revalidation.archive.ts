import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import * as Schema from "effect/Schema";
import type { V2ThreadRecords } from "./Orchestration.records.ts";
import { V2PluginPublication, v2PluginContentHash } from "./PluginSetup.record.ts";
import { recoveryDigest } from "./RebootRecovery.schema.ts";

const Archive = Schema.Struct({
  format: Schema.Literal("bigbud.thread.locked-installation-identity.v1"),
  archivedSignedInstallation: Schema.Unknown,
  revalidated: V2PluginPublication,
});

export const v2LockedInstallationArchiveKey = (signed: unknown) =>
  `locked-installation-identity:${recoveryDigest(signed)}`;

/** Only exact signed metadata archives may coexist without a reboot checkpoint. Unknown,
 * partial or mismatched evidence still blocks; recognized archives never become reboot proof. */
export async function hasOnlyV2LockedInstallationArchives(store: V2ThreadRecords) {
  const entries = await store.inventory();
  if (!entries.length) return false;
  for (const entry of entries) {
    try {
      const value = Schema.decodeUnknownSync(Archive)(entry.signed.value, {
        onExcessProperty: "error",
      });
      const signed = store.verifySignedRecord(value.archivedSignedInstallation);
      const old = Schema.decodeUnknownSync(V2PluginPublication)(signed.value, {
        onExcessProperty: "error",
      });
      const dev = value.revalidated.rootIdentity.dev;
      if (
        entry.name !==
          createHash("sha256")
            .update(v2LockedInstallationArchiveKey(value.archivedSignedInstallation))
            .digest("hex") ||
        old.phase !== "committed" ||
        !old.nextIdentity ||
        old.next.hash !== v2PluginContentHash(old.next.content) ||
        typeof dev !== "number" ||
        typeof old.rootIdentity.dev !== "number" ||
        dev === old.rootIdentity.dev ||
        old.pluginsIdentity.dev !== old.rootIdentity.dev ||
        old.nextIdentity.dev !== old.rootIdentity.dev ||
        !isDeepStrictEqual(value.revalidated, {
          ...old,
          rootIdentity: { ...old.rootIdentity, dev },
          pluginsIdentity: { ...old.pluginsIdentity, dev },
          nextIdentity: { ...old.nextIdentity, dev },
        })
      )
        return false;
    } catch {
      return false;
    }
  }
  return true;
}
