import type { RightPanelTabKind } from "~/stores/rightPanel/rightPanelTabs.store";
import { MenuItem, MenuShortcut } from "../ui/menu";
import { TAB_ICONS, TAB_LABELS } from "./RightPanelTabs.shared";

export function TabMenuItem(props: {
  disabled?: boolean;
  kind: RightPanelTabKind;
  label?: string;
  onSelect: () => void;
  shortcutLabel: string | null;
}) {
  const Icon = TAB_ICONS[props.kind];

  return (
    <MenuItem disabled={props.disabled} onClick={props.onSelect}>
      <Icon className="size-3.5" />
      <span>{props.label ?? TAB_LABELS[props.kind]}</span>
      {props.shortcutLabel ? <MenuShortcut>{props.shortcutLabel}</MenuShortcut> : null}
    </MenuItem>
  );
}
