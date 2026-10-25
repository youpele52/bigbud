import * as Schema from "effect/Schema";
import { v2WindowsInspector } from "./SharedService.windows.ts";

// No conversion through Number: NTFS/ReFS file IDs can use all 128 bits.
const Identity = Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}:[a-f0-9]{32}$/));
const decodeIdentity = Schema.decodeUnknownSync(Identity);

/** A snapshot is not a publication lease; later writes still require a retained native handle contract. */
export function decodeV2WindowsDirectoryIdentity(fields: readonly string[]) {
  if (fields.length !== 1) throw new Error("V2 Windows directory identity layout rejected.");
  try {
    return decodeIdentity(fields[0]);
  } catch {
    throw new Error("V2 Windows directory identity encoding rejected.");
  }
}

/** Negotiate optional operations before issuing them; old helpers never become a fallback. */
export async function requireV2WindowsInspectionFeature(
  feature: "boot=1" | "directory-identity=1",
) {
  const capabilities = await v2WindowsInspector.request("CAPABILITIES\t1");
  if (!capabilities.includes(feature))
    throw new Error("V2 native inspection feature unavailable; rebuild the bigbud helper.");
}

export async function readV2WindowsDirectoryIdentity(directory: string) {
  await requireV2WindowsInspectionFeature("directory-identity=1");
  return decodeV2WindowsDirectoryIdentity(
    await v2WindowsInspector.request(`DIRECTORY\t${Buffer.from(directory).toString("hex")}`),
  );
}
