import type { ProviderKind } from "@bigbud/contracts/orchestration/orchestration.provider";
import type { ServerProviderModel } from "@bigbud/contracts/server/server.providers.ts";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useRef, type RefObject } from "react";
import { ProviderModelRow } from "./ProviderCard.modelRow";

const MODEL_ROW_HEIGHT = 24;
const MODEL_LIST_HEIGHT = 160;

/** Mounts only visible model rows, including catalogs with thousands of models. */
export function ProviderModelList({
  provider,
  models,
  modelListRef,
  onRemoveCustomModel,
}: {
  provider: ProviderKind;
  models: ReadonlyArray<ServerProviderModel>;
  modelListRef: RefObject<HTMLDivElement | null>;
  onRemoveCustomModel: (slug: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const getItemKey = useCallback(
    (index: number) => {
      const model = models[index]!;
      return `${provider}:${model.slug}:${model.subProviderID ?? "default"}:${model.isCustom ? "custom" : "built-in"}`;
    },
    [models, provider],
  );
  const virtualizer = useVirtualizer({
    count: models.length,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize: () => MODEL_ROW_HEIGHT,
    overscan: 3,
    initialRect: { width: 0, height: MODEL_LIST_HEIGHT },
  });

  return (
    <div
      ref={(element) => {
        scrollRef.current = element;
        modelListRef.current = element;
      }}
      className="mt-2 max-h-40 overflow-y-auto pb-1"
      style={{ height: Math.min(MODEL_LIST_HEIGHT, virtualizer.getTotalSize() + 4) }}
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => (
          <div
            key={row.key}
            className="absolute top-0 left-0 w-full"
            style={{ height: row.size, transform: `translateY(${row.start}px)` }}
          >
            <ProviderModelRow
              model={models[row.index]!}
              onRemoveCustomModel={onRemoveCustomModel}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
