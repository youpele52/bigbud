import type { ServerProviderModel } from "@bigbud/contracts/server/server.providers.ts";
import type { RefObject } from "react";
import { ProviderDetails } from "./ProviderDetails";
import { ProviderModelList } from "./ProviderCard.modelList";

/** Keep the native catalog out of the way and mount virtualized rows only when requested. */
export function ProviderModelCatalog({
  models,
  modelListRef,
  onRemoveCustomModel,
}: {
  models: ReadonlyArray<ServerProviderModel>;
  modelListRef: RefObject<HTMLDivElement | null>;
  onRemoveCustomModel: (slug: string) => void;
}) {
  return (
    <div className="border-t border-border/60 px-4 py-3 sm:px-5">
      <ProviderDetails
        label={`Model catalog · ${models.length.toLocaleString()} model${models.length === 1 ? "" : "s"}`}
        lazy
      >
        <p>Catalog entries may require account or model setup before use.</p>
        <ProviderModelList
          provider="opencodeV2"
          models={models}
          modelListRef={modelListRef}
          onRemoveCustomModel={onRemoveCustomModel}
        />
      </ProviderDetails>
    </div>
  );
}
