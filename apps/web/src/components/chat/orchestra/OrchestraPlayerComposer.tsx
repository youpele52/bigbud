import {
  type ExecutionTargetId,
  type ModelSelection,
  type ServerDiscoveredAgent,
  type ServerDiscoveredSkill,
  type ServerProvider,
} from "@bigbud/contracts";
import { XIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { openChatFileTarget } from "../common/chatFileTargets";
import { ComposerAttachmentMenu } from "../composer/ComposerAttachmentMenu";
import { ComposerCommandMenu } from "../composer/ComposerCommandMenu";
import { ComposerListeningBar } from "../composer/ComposerListeningBar";
import { ComposerMicButton } from "../composer/ComposerMicButton";
import { ComposerPromptEditor } from "../composer/ComposerPromptEditor";
import { ProviderModelPicker } from "../provider/ProviderModelPicker";
import { useOrchestraPlayerComposer } from "./OrchestraPlayerComposer.logic";
import { createOrchestraModelSelection } from "./OrchestraPlayerComposer.menu";
import { type ModelOptionsByProvider } from "./OrchestraPlayerComposer.types";

export function OrchestraPlayerComposer(props: {
  index: number;
  assignment: {
    id: string;
    modelSelection: ModelSelection;
    prompt: string;
  };
  providers: ReadonlyArray<ServerProvider>;
  modelOptionsByProvider: ModelOptionsByProvider;
  discoveredAgents: ReadonlyArray<ServerDiscoveredAgent>;
  discoveredSkills: ReadonlyArray<ServerDiscoveredSkill>;
  activeProjectCwd: string | null;
  workspaceExecutionTargetId?: ExecutionTargetId | null | undefined;
  resolvedTheme: "light" | "dark";
  canRemove: boolean;
  onChange: (update: Partial<{ prompt: string; modelSelection: ModelSelection }>) => void;
  onRemove: () => void;
}) {
  const composer = useOrchestraPlayerComposer({
    assignment: props.assignment,
    providers: props.providers,
    modelOptionsByProvider: props.modelOptionsByProvider,
    discoveredAgents: props.discoveredAgents,
    discoveredSkills: props.discoveredSkills,
    activeProjectCwd: props.activeProjectCwd,
    workspaceExecutionTargetId: props.workspaceExecutionTargetId,
    onChange: props.onChange,
  });

  return (
    <div
      className={cn(
        "group rounded-[22px] p-px transition-colors duration-200",
        composer.providerState.composerFrameClassName,
      )}
    >
      <div
        className={cn(
          "relative rounded-[20px] border bg-card transition-colors duration-200",
          composer.providerState.composerSurfaceClassName,
        )}
      >
        <div className="absolute right-1.5 top-1.5 sm:right-2 sm:top-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  aria-label="Remove player"
                  disabled={!props.canRemove}
                  onClick={props.onRemove}
                />
              }
            >
              <XIcon className="size-4" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {props.canRemove ? "Remove player" : "Keep at least two players"}
            </TooltipPopup>
          </Tooltip>
        </div>

        <div className="px-3 pt-3 pb-1.5 sm:px-4 sm:pt-4 sm:pb-2">
          <span className="font-medium text-xs">Player {props.index + 1}</span>
        </div>

        <div className="relative px-3 pb-2 sm:px-4">
          {composer.syntheticMenuKind || composer.trigger ? (
            <div className="absolute inset-x-0 bottom-full z-20 mb-2 px-1">
              <ComposerCommandMenu
                items={composer.composerMenuItems}
                resolvedTheme={props.resolvedTheme}
                isLoading={composer.isComposerMenuLoading}
                triggerKind={
                  composer.syntheticMenuKind
                    ? composer.syntheticMenuKind === "skill"
                      ? "skill"
                      : "path"
                    : (composer.trigger?.kind ?? null)
                }
                discoverySearch={composer.discoverySearch}
                activeItemId={composer.activeComposerMenuItem?.id ?? null}
                onHighlightedItemChange={composer.setHighlightedItemId}
                onSelect={composer.onSelectComposerItem}
                onOpenItemSourcePath={(item) => {
                  const sourcePath =
                    item.type === "agent" ? item.agent.sourcePath : item.skill.sourcePath;
                  if (!sourcePath) return;
                  openChatFileTarget(sourcePath, props.activeProjectCwd ?? undefined);
                }}
              />
            </div>
          ) : null}

          <ComposerPromptEditor
            ref={composer.editorRef}
            value={props.assignment.prompt}
            cursor={composer.cursor}
            terminalContexts={[]}
            discoveredSkills={props.discoveredSkills}
            onRemoveTerminalContext={() => undefined}
            onChange={composer.onPromptChange}
            onCommandKeyDown={composer.onCommandKeyDown}
            onPaste={() => undefined}
            placeholder="Write this player's cue"
            disabled={false}
            className="min-h-[2.5rem]"
          />
        </div>

        <div className="flex min-w-0 items-center justify-between gap-2 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
          <div className="-m-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <ProviderModelPicker
              compact
              provider={composer.selectedProvider}
              model={composer.providerModelValue}
              lockedProvider={null}
              providers={props.providers}
              modelOptionsByProvider={props.modelOptionsByProvider}
              enableRecentlyUsed
              {...(composer.providerState.modelPickerIconClassName
                ? { activeProviderIconClassName: composer.providerState.modelPickerIconClassName }
                : {})}
              onProviderModelChange={(provider, model, subProviderID) => {
                props.onChange({
                  modelSelection: createOrchestraModelSelection({
                    provider,
                    model,
                    ...(subProviderID ? { subProviderID } : {}),
                    providers: props.providers,
                    prompt: props.assignment.prompt,
                  }),
                });
              }}
            />
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {composer.isRecording ? (
              <ComposerListeningBar onStop={() => composer.micRef.current?.stopRecording()} />
            ) : (
              <ComposerAttachmentMenu
                onAttachFiles={() => undefined}
                onOpenReadDialog={() => undefined}
                onCallAgent={() => {
                  composer.setSyntheticMenuKind("agent");
                  composer.setHighlightedItemId(null);
                }}
                onUseSkill={() => {
                  composer.setSyntheticMenuKind("skill");
                  composer.setHighlightedItemId(null);
                }}
                showAttachFiles={false}
                showReadDialog={false}
              />
            )}
            <span
              aria-hidden={composer.isRecording}
              className={composer.isRecording ? "hidden" : ""}
            >
              <ComposerMicButton
                ref={composer.micRef}
                prompt={props.assignment.prompt}
                onTranscript={(text) => {
                  composer.setPromptValue(text, text.length, text.length);
                }}
                onRecordingChange={composer.setIsRecording}
              />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
