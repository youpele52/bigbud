import type { ProviderSession } from "@bigbud/contracts";

/** Full access is explicit user trust; Auto edits broadens only already bounded canonical file mutation. */
export function v2CanonicalActionIsAutomatic(mode: ProviderSession["runtimeMode"], action: string) {
  return (
    mode === "full-access" ||
    (mode === "auto-accept-edits" && (action === "write" || action === "edit"))
  );
}
