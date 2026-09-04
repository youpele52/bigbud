import type { CodexModelOptions } from "@bigbud/contracts/core/model";
import { normalizeCodexModelOptionsWithCapabilities } from "@bigbud/shared/model";

import { getCodexModelCapabilities } from "./Provider.models";

export function shouldEnableCodexCliFastMode(input: {
  readonly model: string;
  readonly options: CodexModelOptions | undefined;
  readonly customModels: ReadonlyArray<string>;
}): boolean {
  if (input.options?.fastMode !== true) {
    return false;
  }

  const normalized = normalizeCodexModelOptionsWithCapabilities(
    getCodexModelCapabilities(input.model),
    input.options,
  );
  if (normalized?.fastMode === true) {
    return true;
  }

  const model = input.model.trim();
  return input.customModels.some((customModel) => customModel.trim() === model);
}
