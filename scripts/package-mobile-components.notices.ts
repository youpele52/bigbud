import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isWithin } from "./lib/remote-backend-control/closure.ts";
import { canonicalInput, readStableFile } from "./lib/artifact-build/io.ts";

/** Third-party notice texts published beside the signed mobile artifacts. They are unsigned
 * sidecars named `<artifact file>.THIRD_PARTY_NOTICES`; the signed metadata format is unchanged. */
export interface MobileComponentNotices {
  /** `bun run licenses:rust --package bigbud-mobile-gateway --target <triple> --notices-output`. */
  readonly gateway: string;
  /** `bun run licenses:mobile-web --notices-output`. */
  readonly assets: string;
}

export const NOTICES_SUFFIX = ".THIRD_PARTY_NOTICES";
const MAX_NOTICES_BYTES = 16 * 1024 * 1024;

/** Read both texts before anything is signed; they must be plain text outside the output. */
export async function readMobileComponentNotices(
  notices: MobileComponentNotices | undefined,
  output: string,
) {
  if (!notices) return undefined;
  const read = async (path: string) => {
    const canonical = await canonicalInput(path);
    if (isWithin(output, canonical)) throw new Error("Notice inputs must be outside the output.");
    const { bytes } = await readStableFile(canonical, MAX_NOTICES_BYTES);
    if (!bytes.length || bytes.includes(0))
      throw new Error("Notice inputs must be non-empty text.");
    return bytes;
  };
  return { gateway: await read(notices.gateway), assets: await read(notices.assets) };
}

export async function writeMobileComponentNotices(
  output: string,
  names: { readonly gateway: string; readonly assets: string },
  texts: Awaited<ReturnType<typeof readMobileComponentNotices>>,
) {
  if (!texts) return;
  for (const kind of ["gateway", "assets"] as const)
    await writeFile(join(output, `${names[kind]}${NOTICES_SUFFIX}`), texts[kind], {
      flag: "wx",
      mode: 0o444,
    });
}
