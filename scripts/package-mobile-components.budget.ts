import { createGunzip } from "node:zlib";
import { MOBILE_ASSET_MAX_EXPANDED_BYTES } from "@bigbud/shared/mobileOptionalAssets.policy";

class MobileArchiveExpansionBudgetError extends Error {}

/** Count actual header/PAX/data/padding bytes, including the producer's final record rounding. */
export async function assertMobileArchiveExpansionBudget(bytes: Buffer): Promise<void> {
  const gzip = createGunzip({ chunkSize: 64 * 1024 });
  let expanded = 0;
  try {
    gzip.end(bytes);
    for await (const value of gzip) {
      expanded += (value as Buffer).length;
      if (expanded > MOBILE_ASSET_MAX_EXPANDED_BYTES) {
        throw new MobileArchiveExpansionBudgetError(
          "Mobile archive total expansion budget exceeded before signing.",
        );
      }
    }
  } catch (error) {
    if (error instanceof MobileArchiveExpansionBudgetError) throw error;
    throw new Error("Mobile archive decompression failed before signing.", { cause: error });
  } finally {
    gzip.destroy();
  }
}
