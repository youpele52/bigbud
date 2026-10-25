import { Toggle, ToggleGroup } from "../ui/toggle-group";

export type MonitorScope = "system" | "bigbud";

export function MonitorScopeToggle({
  scope,
  onScopeChange,
}: {
  scope: MonitorScope;
  onScopeChange: (scope: MonitorScope) => void;
}) {
  return (
    <ToggleGroup
      aria-label="Switch monitor scope"
      variant="toolbar"
      size="xs"
      className="shrink-0"
      value={[scope]}
      onValueChange={(value) => {
        const next = value[0];
        if (next === "system" || next === "bigbud") onScopeChange(next);
      }}
    >
      <Toggle aria-label="Monitor system resources" value="system">
        System
      </Toggle>
      <Toggle aria-label="Monitor bigbud resources" value="bigbud">
        bigbud
      </Toggle>
    </ToggleGroup>
  );
}
