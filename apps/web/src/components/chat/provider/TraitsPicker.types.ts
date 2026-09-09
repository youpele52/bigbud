import type { ProviderKind, ServerProviderModel, ThreadId } from "@bigbud/contracts";
import type { VariantProps } from "class-variance-authority";

import type { buttonVariants } from "../../ui/button";
import type { TraitsPickerProviderOptions as ProviderOptions } from "./TraitsPicker.logic";

export type TraitsPersistence =
  | {
      threadId: ThreadId;
      onModelOptionsChange?: never;
    }
  | {
      threadId?: undefined;
      onModelOptionsChange: (nextOptions: ProviderOptions | undefined) => void;
    };

export interface TraitsMenuContentProps {
  provider: ProviderKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  subProviderID?: string | null | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  modelOptions?: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
}
