import { type ModelSelection, type ProviderKind, type ServerProvider } from "@bigbud/contracts";
import { useState } from "react";
import { ProviderModelPicker } from "~/components/chat/provider/ProviderModelPicker";
import type { ModelOption } from "~/components/chat/provider/ProviderModelPicker.models";
import { MobileComposerModelPicker } from "../components/threads/thread/composer/MobileComposerModelPicker";
import { parityProviders } from "./MobileParityReference.data";

// Fictional selector data only. No provider process, credentials or capability is represented.
const providers: ReadonlyArray<ServerProvider> = [
  {
    ...parityProviders[0]!,
    models: [
      { slug: "fixture-alpha", name: "Fixture Alpha", isCustom: false, capabilities: null },
      { slug: "fixture-beta", name: "Fixture Beta", isCustom: false, capabilities: null },
    ],
  },
  {
    ...parityProviders[0]!,
    provider: "claudeAgent",
    models: [{ slug: "fixture-gamma", name: "Fixture Gamma", isCustom: false, capabilities: null }],
  },
];
const modelOptions: Record<ProviderKind, ReadonlyArray<ModelOption>> = {
  codex: [],
  claudeAgent: [],
  cliProxy: [],
  copilot: [],
  cursor: [],
  devin: [],
  muse: [],
  opencode: [],
  opencodeV2: [],
  pi: [],
};
for (const provider of providers) {
  modelOptions[provider.provider] = provider.models.map(({ slug, name }) => ({
    slug,
    name: name ?? slug,
  }));
}

export function MobileParityProviders({ client }: { client: "desktop" | "mobile" }) {
  const [selection, setSelection] = useState<ModelSelection>({
    provider: "codex",
    model: "fixture-alpha",
  });
  const [updates, setUpdates] = useState(0);
  function update(next: ModelSelection) {
    setUpdates((count) => count + 1);
    setSelection(next);
  }
  return (
    <>
      {client === "desktop" ? (
        <ProviderModelPicker
          compact
          provider={selection.provider}
          model={selection.model}
          lockedProvider={null}
          providers={providers}
          modelOptionsByProvider={modelOptions}
          onProviderModelChange={(provider, model) => update({ provider, model } as ModelSelection)}
        />
      ) : (
        <MobileComposerModelPicker
          selection={selection}
          lockedProvider={null}
          providers={providers}
          onChange={update}
        />
      )}
      <output data-provider-selection="true" data-updates={updates}>
        {selection.provider}:{selection.model}
      </output>
    </>
  );
}
