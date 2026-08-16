import * as Schema from "effect/Schema";
import type { ServerProvider } from "@bigbud/contracts";

import { getLocalStorageItem } from "~/hooks/useLocalStorage";
import {
  RecentModelUsage as RecentModelUsageSchema,
  type RecentModelUsage as RecentModelUsageValue,
} from "./recentlyUsedModels";
import { getProviderDescriptor } from "~/components/chat/provider/providerDescriptors";
import { getProviderModels } from "~/models/provider";

export const COMPACT_CHAT_MODEL_PREFERENCE_STORAGE_KEY = "bigbud:compact-chat:default-model:v1";
export const CompactChatModelPreference = Schema.NullOr(RecentModelUsageSchema);

export type CompactChatModelPreference = RecentModelUsageValue;

export function getCompactChatModelPreference(): CompactChatModelPreference | null {
  return getLocalStorageItem(COMPACT_CHAT_MODEL_PREFERENCE_STORAGE_KEY, CompactChatModelPreference);
}

export function isCompactChatModelPreferenceAvailable(
  preference: CompactChatModelPreference,
  providers: ReadonlyArray<ServerProvider>,
): boolean {
  const provider = providers.find((candidate) => candidate.provider === preference.provider);
  if (!provider?.enabled) return false;
  if (!getProviderDescriptor(preference.provider).catalogAuthoritative) return true;
  return getProviderModels(providers, preference.provider).some(
    (model) =>
      model.slug === preference.model &&
      (model.subProviderID ?? undefined) === (preference.subProviderID ?? undefined),
  );
}
