import { type ModelSelection, type ProviderKind, type ServerProvider } from "@bigbud/contracts";

import { createModelSelection, getProviderModels } from "~/models/provider";

import { type ComposerTrigger } from "../../../logic/composer";
import { type ComposerCommandItem } from "../composer/ComposerCommandMenu";
import { getComposerProviderState } from "../provider/composerProviderRegistry";
import { AVAILABLE_PROVIDER_OPTIONS } from "../provider/ProviderModelPicker";
import { providerSupportsSubProviderID } from "../view/ChatView.modelSelection.logic";
import { type ModelOptionsByProvider } from "./OrchestraPlayerComposer.types";

const UNSUPPORTED_ORCHESTRA_COMMANDS = new Set(["compact", "default", "plan", "read"]);

export function extendReplacementRangeForTrailingSpace(
  text: string,
  rangeEnd: number,
  replacement: string,
): number {
  if (!replacement.endsWith(" ")) return rangeEnd;
  return text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
}

export function filterUnsupportedSlashCommands(
  items: ComposerCommandItem[],
): ComposerCommandItem[] {
  return items.filter(
    (item) => item.type !== "slash-command" || !UNSUPPORTED_ORCHESTRA_COMMANDS.has(item.command),
  );
}

export function buildSearchableModelOptions(
  modelOptionsByProvider: ModelOptionsByProvider,
): ReadonlyArray<{
  provider: ProviderKind;
  providerLabel: string;
  slug: string;
  name: string;
  subProviderID: string | undefined;
  searchSlug: string;
  searchName: string;
  searchProvider: string;
  searchGroup: string;
}> {
  return AVAILABLE_PROVIDER_OPTIONS.flatMap((option) =>
    modelOptionsByProvider[option.value].map(({ slug, name, subProviderID, group }) => ({
      provider: option.value,
      providerLabel: option.label,
      slug,
      name,
      subProviderID,
      searchSlug: slug.toLowerCase(),
      searchName: name.toLowerCase(),
      searchProvider: option.label.toLowerCase(),
      searchGroup: group?.toLowerCase() ?? "",
    })),
  );
}

export function createOrchestraModelSelection(input: {
  provider: ProviderKind;
  model: string;
  subProviderID?: string;
  providers: ReadonlyArray<ServerProvider>;
  prompt: string;
}): ModelSelection {
  const models = getProviderModels(input.providers, input.provider);
  const providerState = getComposerProviderState({
    provider: input.provider,
    model: input.model,
    models,
    prompt: input.prompt,
    modelOptions: {
      [input.provider]: undefined,
    },
  });
  const baseSelection = createModelSelection(
    input.provider,
    input.model,
    providerState.modelOptionsForDispatch,
  );
  if (providerSupportsSubProviderID(input.provider) && input.subProviderID) {
    return { ...baseSelection, subProviderID: input.subProviderID } as ModelSelection;
  }
  return baseSelection;
}

export function resolveDiscoverySearch(input: {
  syntheticMenuKind: "agent" | "skill" | null;
  syntheticMenuSearch: string;
  trigger: ComposerTrigger | null;
  applyPromptReplacement: (rangeStart: number, rangeEnd: number, replacement: string) => boolean;
  onResetHighlight: () => void;
}): {
  command: "agents" | "skills" | "model";
  query: string;
  onQueryChange: (query: string) => void;
} | null {
  if (input.syntheticMenuKind) {
    return {
      command: input.syntheticMenuKind === "agent" ? "agents" : "skills",
      query: input.syntheticMenuSearch,
      onQueryChange: () => {
        input.onResetHighlight();
      },
    };
  }

  const trigger = input.trigger;
  if (trigger?.kind === "slash-command") {
    const normalizedQuery = trigger.query.trim().toLowerCase();
    const command =
      normalizedQuery === "agents" || normalizedQuery.startsWith("agents ")
        ? "agents"
        : normalizedQuery.startsWith("skill")
          ? "skills"
          : null;
    if (!command) return null;

    return {
      command,
      query:
        command === "agents"
          ? normalizedQuery.startsWith("agents ")
            ? trigger.query.slice("agents ".length)
            : ""
          : normalizedQuery.startsWith("skills ")
            ? trigger.query.slice("skills ".length)
            : normalizedQuery.startsWith("skill ")
              ? trigger.query.slice("skill ".length)
              : "",
      onQueryChange: (query) => {
        const replacement = query.trim().length > 0 ? `/${command} ${query}` : `/${command} `;
        if (input.applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, replacement)) {
          input.onResetHighlight();
        }
      },
    };
  }

  if (trigger?.kind === "slash-model") {
    return {
      command: "model",
      query: trigger.query,
      onQueryChange: (query) => {
        const replacement = query.trim().length > 0 ? `/model ${query}` : "/model ";
        if (input.applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, replacement)) {
          input.onResetHighlight();
        }
      },
    };
  }

  return null;
}
