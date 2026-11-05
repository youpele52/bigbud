import { ProviderInteractionMode, RuntimeMode } from "@bigbud/contracts";
import { memo, type ReactNode } from "react";
import { EllipsisIcon, ListMusicIcon, ListTodoIcon, MessageSquareShare } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../../ui/menu";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  compact?: boolean;
  interactionMode: ProviderInteractionMode;
  planCardOpen: boolean;
  planCardLabel: string;
  runtimeMode: RuntimeMode;
  traitsMenuContent?: ReactNode;
  onOpenOrchestra: () => void;
  onOpenSideChat?: (() => void) | undefined;
  sideChatDisabled?: boolean | undefined;
  onToggleInteractionMode: () => void;
  onTogglePlanCard: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  /** Server-published qualified modes; absent retains existing-provider behavior. */
  supportedRuntimeModes?: ReadonlyArray<RuntimeMode>;
  supportedInteractionModes?: ReadonlyArray<ProviderInteractionMode>;
  unsupportedModeReason?: string;
}) {
  const runtimeModeDisabled = (mode: RuntimeMode) =>
    props.supportedRuntimeModes !== undefined && !props.supportedRuntimeModes.includes(mode);
  const interactionModeDisabled = (mode: ProviderInteractionMode) =>
    props.supportedInteractionModes !== undefined &&
    !props.supportedInteractionModes.includes(mode);
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 px-2 text-xs text-muted-foreground/70 hover:text-foreground/80"
            aria-label="More composer controls"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup
        align="start"
        className={cn(
          "[--available-height:50dvh]",
          props.compact &&
            "[&_[data-slot=menu-item]]:text-xs [&_[data-slot=menu-radio-item]]:text-xs sm:[&_[data-slot=menu-item]]:text-xs sm:[&_[data-slot=menu-radio-item]]:text-xs",
        )}
      >
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            <MenuDivider />
          </>
        ) : null}
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
        <MenuRadioGroup
          value={props.interactionMode}
          onValueChange={(value) => {
            if (!value || value === props.interactionMode) return;
            props.onToggleInteractionMode();
          }}
        >
          <MenuRadioItem value="default" disabled={interactionModeDisabled("default")}>
            Chat
          </MenuRadioItem>
          <MenuRadioItem value="plan" disabled={interactionModeDisabled("plan")}>
            Plan
          </MenuRadioItem>
        </MenuRadioGroup>
        <MenuDivider />
        {props.onOpenSideChat ? (
          <MenuItem disabled={props.sideChatDisabled} onClick={props.onOpenSideChat}>
            <MessageSquareShare className="size-4 shrink-0" />
            Sidecar
          </MenuItem>
        ) : null}
        <MenuItem onClick={props.onOpenOrchestra}>
          <ListMusicIcon className="size-4 shrink-0" />
          Orchestrate
        </MenuItem>
        <MenuDivider />
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
        <MenuRadioGroup
          value={props.runtimeMode}
          onValueChange={(value) => {
            if (!value || value === props.runtimeMode) return;
            props.onRuntimeModeChange(value as RuntimeMode);
          }}
        >
          <MenuRadioItem
            value="approval-required"
            disabled={runtimeModeDisabled("approval-required")}
          >
            Supervised
          </MenuRadioItem>
          <MenuRadioItem
            value="auto-accept-edits"
            disabled={runtimeModeDisabled("auto-accept-edits")}
          >
            Auto-accept edits
          </MenuRadioItem>
          <MenuRadioItem value="full-access" disabled={runtimeModeDisabled("full-access")}>
            Full access
          </MenuRadioItem>
        </MenuRadioGroup>
        {props.supportedRuntimeModes !== undefined && props.unsupportedModeReason ? (
          <div className="max-w-64 px-2 py-1.5 text-xs text-muted-foreground">
            {props.unsupportedModeReason}
          </div>
        ) : null}
        <MenuDivider />
        <MenuItem onClick={props.onTogglePlanCard}>
          <ListTodoIcon className="size-4 shrink-0" />
          {props.planCardOpen
            ? `Hide ${props.planCardLabel.toLowerCase()}`
            : `Show ${props.planCardLabel.toLowerCase()}`}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
});
