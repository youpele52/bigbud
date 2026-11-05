import { Toggle, ToggleGroup } from "../ui/toggle-group";

export type MonitorScope = "system" | "bigbud" | `vps:${string}`;

export function MonitorScopeToggle({
  scope,
  onScopeChange,
  remotes = [],
}: {
  scope: MonitorScope;
  onScopeChange: (scope: MonitorScope) => void;
  remotes?: ReadonlyArray<{ scope: `vps:${string}`; name: string }>;
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
        if (next === "system" || next === "bigbud" || remotes.some((entry) => entry.scope === next))
          onScopeChange(next as MonitorScope);
      }}
    >
      <Toggle aria-label="Monitor system resources" value="system">
        System
      </Toggle>
      <Toggle aria-label="Monitor bigbud resources" value="bigbud">
        bigbud
      </Toggle>
      {remotes.map((remote) => (
        <Toggle
          key={remote.scope}
          aria-label={`Monitor ${remote.name} resources`}
          value={remote.scope}
        >
          {remote.name}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
