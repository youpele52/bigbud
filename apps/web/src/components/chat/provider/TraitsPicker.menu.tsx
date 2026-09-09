import { type PiThinkingLevel } from "@bigbud/contracts";
import { applyClaudePromptEffortPrefix, getDefaultEffort } from "@bigbud/shared/model";
import { memo, useCallback } from "react";
import {
  MenuGroup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
} from "../../ui/menu";
import { useComposerDraftStore } from "../../../stores/composer";
import {
  buildNextOptions,
  buildNextPiThinkingOptions,
  getSelectedTraits,
  ULTRATHINK_PROMPT_PREFIX,
  type TraitsPickerProviderOptions as ProviderOptions,
} from "./TraitsPicker.logic";
import { ClaudeWorkflowMenu } from "./TraitsPicker.workflow";
import type { TraitsMenuContentProps, TraitsPersistence } from "./TraitsPicker.types";

export const TraitsMenuContent = memo(function TraitsMenuContentImpl({
  provider,
  models,
  model,
  subProviderID,
  prompt,
  onPromptChange,
  modelOptions,
  allowPromptInjectedEffort = true,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const persistenceThreadId = "threadId" in persistence ? persistence.threadId : undefined;
  const persistenceModelOptionsChange =
    "onModelOptionsChange" in persistence ? persistence.onModelOptionsChange : undefined;
  const updateModelOptions = useCallback(
    (nextOptions: ProviderOptions | undefined) => {
      if (persistenceModelOptionsChange) {
        persistenceModelOptionsChange(nextOptions);
        return;
      }
      if (!persistenceThreadId) {
        return;
      }
      setProviderModelOptions(persistenceThreadId, provider, nextOptions, { persistSticky: true });
    },
    [persistenceModelOptionsChange, persistenceThreadId, provider, setProviderModelOptions],
  );
  const traits = getSelectedTraits(
    provider,
    models,
    model,
    prompt,
    modelOptions,
    allowPromptInjectedEffort,
    subProviderID,
  );
  const {
    caps,
    effort,
    thinkingLevel,
    thinkingLevels,
    workflowModes,
    ultracodeEnabled,
    effortLevels,
    thinkingEnabled,
    fastModeEnabled,
    contextWindowOptions,
    contextWindow,
    defaultContextWindow,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    hasEffortOptions,
  } = traits;
  const defaultEffort = getDefaultEffort(caps);

  const handleEffortChange = useCallback(
    (value: string) => {
      if (!value) return;
      const nextOption = effortLevels.find((option) => option.value === value);
      if (!nextOption) return;
      if (caps.promptInjectedEffortLevels.includes(nextOption.value)) {
        const nextPrompt =
          prompt.trim().length === 0
            ? ULTRATHINK_PROMPT_PREFIX
            : applyClaudePromptEffortPrefix(prompt, "ultrathink");
        onPromptChange(nextPrompt);
        return;
      }
      if (ultrathinkInBodyText) return;
      if (ultrathinkPromptControlled) {
        const stripped = prompt.replace(/^Ultrathink:\s*/i, "");
        onPromptChange(stripped);
      }
      const effortKey =
        provider === "claudeAgent"
          ? "effort"
          : provider === "cursor" || provider === "devin"
            ? "reasoning"
            : "reasoningEffort";
      updateModelOptions(
        buildNextOptions(provider, modelOptions, { [effortKey]: nextOption.value }),
      );
    },
    [
      ultrathinkPromptControlled,
      ultrathinkInBodyText,
      modelOptions,
      onPromptChange,
      updateModelOptions,
      effortLevels,
      prompt,
      caps.promptInjectedEffortLevels,
      provider,
    ],
  );

  if (
    !hasEffortOptions &&
    thinkingLevels.length === 0 &&
    thinkingEnabled === null &&
    workflowModes.length === 0 &&
    contextWindowOptions.length <= 1
  ) {
    return null;
  }

  return (
    <>
      {provider === "pi" ? (
        <MenuGroup>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Thinking</div>
          <MenuRadioGroup
            value={thinkingLevel ?? "pi-default"}
            onValueChange={(value) => {
              updateModelOptions(
                buildNextPiThinkingOptions(
                  modelOptions,
                  value === "pi-default" ? undefined : (value as PiThinkingLevel),
                ),
              );
            }}
          >
            <MenuRadioItem value="pi-default">Pi default</MenuRadioItem>
            {thinkingLevels.map((option) => (
              <MenuRadioItem key={option.value} value={option.value}>
                {option.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      ) : hasEffortOptions ? (
        <>
          <MenuGroup>
            <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">Effort</div>
            {ultrathinkInBodyText ? (
              <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">
                Your prompt contains &quot;ultrathink&quot; in the text. Remove it to change effort.
              </div>
            ) : null}
            <MenuRadioGroup
              value={ultrathinkPromptControlled ? "ultrathink" : (effort ?? "")}
              onValueChange={handleEffortChange}
            >
              {effortLevels.map((option) => (
                <MenuRadioItem
                  key={option.value}
                  value={option.value}
                  disabled={ultrathinkInBodyText}
                >
                  {option.label}
                  {option.value === defaultEffort ? " (default)" : ""}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </>
      ) : thinkingEnabled !== null ? (
        <MenuGroup>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Thinking</div>
          <MenuRadioGroup
            value={thinkingEnabled ? "on" : "off"}
            onValueChange={(value) => {
              updateModelOptions(
                buildNextOptions(provider, modelOptions, { thinking: value === "on" }),
              );
            }}
          >
            <MenuRadioItem value="on">On (default)</MenuRadioItem>
            <MenuRadioItem value="off">Off</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
      ) : null}
      {caps.supportsFastMode ? (
        <>
          <MenuDivider />
          <MenuGroup>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Fast Mode</div>
            <MenuRadioGroup
              value={fastModeEnabled ? "on" : "off"}
              onValueChange={(value) => {
                updateModelOptions(
                  buildNextOptions(provider, modelOptions, { fastMode: value === "on" }),
                );
              }}
            >
              <MenuRadioItem value="off">off</MenuRadioItem>
              <MenuRadioItem value="on">on</MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        </>
      ) : null}
      {workflowModes.some((mode) => mode.value === "ultracode") ? (
        <ClaudeWorkflowMenu
          enabled={ultracodeEnabled}
          modelOptions={modelOptions}
          onModelOptionsChange={updateModelOptions}
        />
      ) : null}
      {contextWindowOptions.length > 1 ? (
        <>
          <MenuDivider />
          <MenuGroup>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
              Context Window
            </div>
            <MenuRadioGroup
              value={contextWindow ?? defaultContextWindow ?? ""}
              onValueChange={(value) => {
                updateModelOptions(
                  buildNextOptions(provider, modelOptions, {
                    contextWindow: value,
                  }),
                );
              }}
            >
              {contextWindowOptions.map((option) => (
                <MenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                  {option.value === defaultContextWindow ? " (default)" : ""}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </>
      ) : null}
    </>
  );
});
