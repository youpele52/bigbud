import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { discoverV2SharedService } from "./SharedService.discovery.ts";
import {
  readV2SharedRegistration,
  sameV2SharedRegistration,
} from "./SharedService.registration.ts";

export interface V2SharedConnection {
  readonly registrationFile: string;
  readonly generation: string;
  readonly storageIdentity: string;
}

/** Registration path is a namespace seed, never native physical-storage attestation. */
export async function resolveV2SharedConnection(file: string): Promise<V2SharedConnection> {
  const original = await readV2SharedRegistration(file);
  const registrationFile = await realpath(file);
  const discovered = await discoverV2SharedService({ file: registrationFile });
  if (!sameV2SharedRegistration(original, discovered.registration))
    throw new Error("V2 shared registration changed during canonical discovery.");
  return {
    registrationFile,
    generation: discovered.generation,
    storageIdentity: createHash("sha256")
      .update(JSON.stringify(["shared-api-v1", registrationFile]))
      .digest("hex"),
  };
}
