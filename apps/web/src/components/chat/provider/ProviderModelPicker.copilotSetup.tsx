import { SettingsIcon } from "lucide-react";
import { MenuItem } from "../../ui/menu";
import { requestCopilotSetup } from "../../../hooks/useCopilotRuntime";

export function CopilotSetupMenuItem({ className }: { className?: string | undefined }) {
  return (
    <MenuItem className={className} onClick={requestCopilotSetup}>
      <SettingsIcon aria-hidden="true" />
      <span>Set up GitHub Copilot</span>
    </MenuItem>
  );
}
