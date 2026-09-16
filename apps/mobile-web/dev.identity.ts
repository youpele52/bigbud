import { realpath } from "node:fs/promises";

export async function resolveMobileDevRepoRoot(
  checkoutRoot: string,
  inheritedRoot: string | undefined,
): Promise<string> {
  const canonicalRoot = await realpath(checkoutRoot);
  if (inheritedRoot !== undefined && (await realpath(inheritedRoot)) !== canonicalRoot) {
    throw new Error("BIGBUD_DEV_REPO_ROOT does not match this mobile checkout");
  }
  return canonicalRoot;
}
