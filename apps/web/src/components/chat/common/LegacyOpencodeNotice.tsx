import { LEGACY_OPENCODE_READ_ONLY_MESSAGE } from "@bigbud/shared/providerLifecycle";
import { TriangleAlertIcon } from "lucide-react";
import { StatusBanner } from "../../common/StatusBanner";

/** Show read-only guidance in the chat's top warning banner area. */
export function LegacyOpencodeNotice() {
  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <StatusBanner
        variant="warning"
        role="status"
        icon={<TriangleAlertIcon />}
        description={LEGACY_OPENCODE_READ_ONLY_MESSAGE}
      />
    </div>
  );
}
