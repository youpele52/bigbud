import { type ProviderKind, type ServerProvider } from "@bigbud/contracts";
import { resolveSelectableModel } from "@bigbud/shared/model";
import { memo, useMemo, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import { ChevronDownIcon } from "lucide-react";
import { Button, buttonVariants } from "../../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator as MenuDivider,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../ui/menu";
import { cn } from "~/lib/utils";
import { getProviderSnapshot } from "../../../models/provider";
import { useRecentlyUsedModels } from "../../../hooks/useRecentlyUsedModels";
import { MAX_RECENT_MODELS_PER_PROVIDER } from "../../../models/recentlyUsedModels";
import { ModelList } from "./ProviderModelPicker.modelList";
import {
  AVAILABLE_PROVIDER_OPTIONS,
  formatSlugAsDisplayName,
  modelOptionValue,
  providerIconClassName,
  providerSupportsSubProviderID,
  PROVIDER_ICON_BY_PROVIDER,
  type ModelOption,
  UNAVAILABLE_PROVIDER_OPTIONS,
} from "./ProviderModelPicker.models";

export { visibleModelOptionsForPicker } from "./ProviderModelPicker.models";
export { AVAILABLE_PROVIDER_OPTIONS } from "./ProviderModelPicker.models";

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
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
  onProviderModelChange: (
    provider: ProviderKind,
    model: string,
    subProviderID?: string | undefined,
  ) => void;
  /** Called when the user clicks the back-arrow to unlock the provider and return to provider selection. */
  onProviderUnlock?: () => void;
}) {
  const allRecentUsages = useRecentlyUsedModels();
  const recentOptionsByProvider = useMemo(() => {
    if (!props.enableRecentlyUsed || allRecentUsages.length === 0) return {};
    const result: Partial<Record<ProviderKind, ModelOption[]>> = {};
    for (const opt of AVAILABLE_PROVIDER_OPTIONS) {
      const providerOptions = props.modelOptionsByProvider[opt.value];
      if (!providerOptions || providerOptions.length === 0) continue;
      const recent = allRecentUsages
        .filter((u) => u.provider === opt.value)
        .toSorted((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
        .slice(0, MAX_RECENT_MODELS_PER_PROVIDER);
      const supportsSubProvider = providerSupportsSubProviderID(opt.value);
      const matched = recent
        .map((u) =>
          providerOptions.find((o) => {
            if (o.slug !== u.model) return false;
            // For providers without sub-providers, match by slug only.
            // This prevents duplicates when the server sends models with
            // a subProviderID that the user-facing selection ignores.
            if (!supportsSubProvider) return true;
            return (o.subProviderID ?? undefined) === (u.subProviderID ?? undefined);
          }),
        )
        .filter((o): o is ModelOption => o !== undefined);
      const uniqueMatched = matched.filter(
        (o, i, arr) =>
          arr.findIndex((other) => modelOptionValue(other) === modelOptionValue(o)) === i,
      );
      if (uniqueMatched.length > 0) result[opt.value] = uniqueMatched;
    }
    return result;
  }, [allRecentUsages, props.enableRecentlyUsed, props.modelOptionsByProvider]);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [view, setView] = useState<"provider" | "model">(
    props.lockedProvider !== null ? "model" : "provider",
  );
  const activeProvider = props.lockedProvider ?? props.provider;
  const selectedProviderOptions = props.modelOptionsByProvider[activeProvider];
  const selectedProviderValue = props.provider === activeProvider ? props.model : "";
  // Extract slug from model value (strip ::subProviderID suffix if present)
  const modelSlug = props.model.includes("::")
    ? (props.model.split("::")[0] ?? props.model)
    : props.model;
  const selectedModelLabel =
    selectedProviderOptions.find((option) => modelOptionValue(option) === selectedProviderValue)
      ?.name ??
    selectedProviderOptions.find((option) => option.slug === modelSlug)?.name ??
    // Fallback: format slug as readable name when options aren't loaded
    formatSlugAsDisplayName(modelSlug);
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[activeProvider];

  const handleModelChange = (provider: ProviderKind, value: string) => {
    if (props.disabled) return;
    if (!value) return;
    const matchedOption = props.modelOptionsByProvider[provider].find(
      (option) => modelOptionValue(option) === value,
    );
    if (matchedOption) {
      props.onProviderModelChange(provider, matchedOption.slug, matchedOption.subProviderID);
      setIsMenuOpen(false);
      return;
    }
    const resolvedModel = resolveSelectableModel(
      provider,
      value,
      props.modelOptionsByProvider[provider],
    );
    if (!resolvedModel) return;
    props.onProviderModelChange(provider, resolvedModel);
    setIsMenuOpen(false);
  };

  return (
    <>
      <Menu
        open={isMenuOpen}
        onOpenChange={(open) => {
          if (props.disabled) {
            setIsMenuOpen(false);
            return;
          }
          if (open) {
            setView(props.lockedProvider !== null ? "model" : "provider");
          }
          setIsMenuOpen(open);
        }}
      >
        <MenuTrigger
          render={
            <Button
              size="sm"
              variant={props.triggerVariant ?? "ghost"}
              data-chat-provider-model-picker="true"
              className={cn(
                "min-w-0 justify-start overflow-hidden whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 [&_svg]:mx-0",
                props.compact ? "max-w-42 shrink-0" : "max-w-48 shrink sm:max-w-56 sm:px-3",
                props.triggerClassName,
              )}
              disabled={props.disabled}
            />
          }
        >
          <span
            className={cn(
              "flex min-w-0 w-full box-border items-center gap-2 overflow-hidden text-xs",
              props.compact ? "max-w-36 sm:pl-1" : undefined,
            )}
          >
            <ProviderIcon
              aria-hidden="true"
              className={cn(
                "size-4 shrink-0",
                providerIconClassName(activeProvider, "text-muted-foreground/70"),
                props.activeProviderIconClassName,
              )}
            />
            <span className="min-w-0 flex-1 truncate">{selectedModelLabel}</span>
            <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
          </span>
        </MenuTrigger>
        <MenuPopup align="start">
          {props.lockedProvider !== null && view === "model" ? (
            <div className="[--available-height:min(24rem,70vh)] max-h-(--available-height) overflow-y-auto">
              <ModelList
                provider={props.lockedProvider}
                selectedValue={selectedProviderValue}
                options={props.modelOptionsByProvider[props.lockedProvider]}
                recentOptions={recentOptionsByProvider[props.lockedProvider]}
                onSelect={(value) => handleModelChange(props.lockedProvider!, value)}
                {...(props.onProviderUnlock
                  ? {
                      onBack: () => {
                        setView("provider");
                        props.onProviderUnlock?.();
                      },
                    }
                  : {})}
              />
            </div>
          ) : (
            <>
              {AVAILABLE_PROVIDER_OPTIONS.map((option) => {
                const OptionIcon = PROVIDER_ICON_BY_PROVIDER[option.value];
                const liveProvider = props.providers
                  ? getProviderSnapshot(props.providers, option.value)
                  : undefined;
                if (liveProvider && liveProvider.status !== "ready") {
                  const unavailableLabel = !liveProvider.enabled
                    ? "Disabled"
                    : !liveProvider.installed
                      ? "Not installed"
                      : "Unavailable";
                  return (
                    <MenuItem
                      key={option.value}
                      disabled
                      title={liveProvider.message ?? unavailableLabel}
                    >
                      <OptionIcon
                        aria-hidden="true"
                        className={cn(
                          "size-4 shrink-0 opacity-80",
                          providerIconClassName(option.value, "text-muted-foreground/85"),
                        )}
                      />
                      <span>{option.label}</span>
                      <span className="ms-auto shrink-0 text-[11px] text-muted-foreground/80 uppercase tracking-[0.08em]">
                        {unavailableLabel}
                      </span>
                    </MenuItem>
                  );
                }
                return (
                  <MenuSub key={option.value}>
                    <MenuSubTrigger>
                      <OptionIcon
                        aria-hidden="true"
                        className={cn(
                          "size-4 shrink-0",
                          providerIconClassName(option.value, "text-muted-foreground/85"),
                        )}
                      />
                      {option.label}
                    </MenuSubTrigger>
                    <MenuSubPopup
                      className="[--available-height:min(24rem,70vh)] !p-0 overflow-hidden"
                      sideOffset={4}
                    >
                      <div className="max-h-(--available-height) overflow-y-auto">
                        <ModelList
                          provider={option.value}
                          selectedValue={props.provider === option.value ? props.model : ""}
                          options={props.modelOptionsByProvider[option.value]}
                          recentOptions={recentOptionsByProvider[option.value]}
                          onSelect={(value) => {
                            handleModelChange(option.value, value);
                          }}
                        />
                      </div>
                    </MenuSubPopup>
                  </MenuSub>
                );
              })}
              {UNAVAILABLE_PROVIDER_OPTIONS.length > 0 && <MenuDivider />}
              {UNAVAILABLE_PROVIDER_OPTIONS.map((option) => {
                const OptionIcon = PROVIDER_ICON_BY_PROVIDER[option.value];
                return (
                  <MenuItem key={option.value} disabled>
                    <OptionIcon
                      aria-hidden="true"
                      className="size-4 shrink-0 text-muted-foreground/85 opacity-80"
                    />
                    <span>{option.label}</span>
                    <span className="ms-auto text-[11px] text-muted-foreground/80 uppercase tracking-[0.08em]">
                      Coming soon
                    </span>
                  </MenuItem>
                );
              })}
            </>
          )}
        </MenuPopup>
      </Menu>
    </>
  );
});
