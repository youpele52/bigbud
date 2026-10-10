import { LEGACY_OPENCODE_READ_ONLY_MESSAGE } from "@bigbud/shared/providerLifecycle";

/** Replace runtime controls without hiding the historical transcript. */
export function LegacyOpencodeNotice() {
  return (
    <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
      {LEGACY_OPENCODE_READ_ONLY_MESSAGE}
    </p>
  );
}
