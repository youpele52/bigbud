import type { ProviderKind, ServerProvider } from "@bigbud/contracts";
import type { VariantProps } from "class-variance-authority";

import type { buttonVariants } from "../../ui/button";
import type { ModelOption } from "./ProviderModelPicker.models";

export interface ProviderModelPickerProps {
  provider: ProviderKind;
  model: string;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProvider>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ModelOption>>;
  activeProviderIconClassName?: string;
  compact?: boolean;
  disabled?: boolean;
  enableRecentlyUsed?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  menuItemClassName?: string;
  popupClassName?: string;
  subPopupClassName?: string;
  modelListSearchbarClassName?: string;
  modelListGroupLabelClassName?: string;
  modelListItemClassName?: string;
  modelListItemLabelClassName?: string;
  onProviderModelChange: (
    provider: ProviderKind,
    model: string,
    subProviderID?: string | undefined,
  ) => void;
  /** Called when the user unlocks the provider and returns to provider selection. */
  onProviderUnlock?: () => void;
}
