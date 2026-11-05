import type { ProviderKind } from "@bigbud/contracts";
import { MenuItem } from "../../ui/menu";
import { cn } from "../../../lib/utils";
import { providerIconClassName, PROVIDER_ICON_BY_PROVIDER } from "./ProviderModelPicker.models";

export function UnavailableProviderMenuItem({
  provider,
  label,
  message,
  className,
}: {
  provider: ProviderKind;
  label: string;
  message: string;
  className?: string | undefined;
}) {
  const Icon = PROVIDER_ICON_BY_PROVIDER[provider];
  return (
    <MenuItem className={className} disabled title={message}>
      <Icon
        aria-hidden="true"
        className={cn(
          "size-4 shrink-0 opacity-80",
          providerIconClassName(provider, "text-muted-foreground/70"),
        )}
      />
      <span>{label}</span>
      <span className="ms-auto max-w-64 truncate text-[11px] text-muted-foreground/80 uppercase tracking-[0.08em]">
        {message}
      </span>
    </MenuItem>
  );
}
