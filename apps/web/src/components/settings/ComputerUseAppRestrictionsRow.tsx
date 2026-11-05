import type { ComputerUseAppSelector } from "@bigbud/contracts/core/settings.computerUsePolicy";

import { Button } from "../ui/button";
import {
  describeAppliedState,
  type SupervisedSettingsView,
} from "./ComputerUseSupervisedSettings.logic";
import { ComputerUseSupervisedStatusText } from "./ComputerUseSupervisedStatusText";
import { SettingsRow } from "./settingsLayout";

function selectorKey(selector: ComputerUseAppSelector): string {
  return `${selector.platform}:${selector.kind}:${selector.value}`;
}

/**
 * App restrictions: all apps are granted except the human's explicit
 * disallow list. Adding an app needs the human-only installed/running
 * inventory, which is not connected yet, so only restore is offered.
 */
export function ComputerUseAppRestrictionsRow({
  view,
  disabled,
  onRestore,
}: {
  view: SupervisedSettingsView;
  disabled: boolean;
  onRestore: (selector: ComputerUseAppSelector) => void;
}) {
  const disallowed = view.kind === "ready" ? view.desired.disallowedApps : [];
  return (
    <SettingsRow
      title="App restrictions"
      description="Agents may use every app except the ones you disallow here."
      status={<ComputerUseSupervisedStatusText copy={describeAppliedState(view)} />}
    >
      <div className="mt-3 space-y-2 text-sm">
        {disallowed.length === 0 ? (
          <p className="text-xs text-muted-foreground">No apps are disallowed.</p>
        ) : (
          <ul className="space-y-1.5">
            {disallowed.map((selector) => (
              <li key={selectorKey(selector)} className="flex items-center justify-between gap-2">
                <span className="min-w-0 break-all">{selector.label ?? selector.value}</span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => onRestore(selector)}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          Choosing apps to disallow becomes available once the app inventory is connected.
        </p>
      </div>
    </SettingsRow>
  );
}
